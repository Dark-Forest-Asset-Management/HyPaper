import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import { getClearinghouseState, getFrontendOpenOrders } from '../engine/position.js';
import { getUserFills } from '../engine/fill.js';
import { getUserFundingPg, getLedgerUpdatesPg } from '../store/pg-queries.js';
import { getActiveAssetData } from '../engine/account.js';
import { app } from '../api/server.js';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import type {
  WsSubscription,
  MidsEvent,
  L2BookEvent,
  FillEvent,
  OrderUpdateEvent,
  AccountUpdateEvent,
} from './types.js';

interface ClientState {
  ws: WebSocket;
  subscriptions: Set<string>;
  isAlive: boolean;
  /** Consecutive heartbeat cycles with no pong. Reset on pong receipt.
   *  Terminate only after MAX_MISSED_HEARTBEATS in a row — gives event-loop
   *  blockage (heavy fill batches, GC pause, big REST response) tolerance. */
  missedHeartbeats: number;
}

const HEARTBEAT_INTERVAL = 30_000;
/** Tolerate 3 missed cycles (~90s) before declaring the client dead. Hard-
 *  observed 2026-06-24: long-lived hl-strat clients were silently dropped
 *  from `subscriptionIndex` because a 30s window was too tight under heavy
 *  fill activity. Result: ghost positions accumulated because the strategy
 *  never received the broadcast for its own fills. */
const MAX_MISSED_HEARTBEATS = 3;

export class HyPaperWsServer {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientState>();
  private subscriptionIndex = new Map<string, Set<WebSocket>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private eventBus: EventEmitter;
  private worker: { ensureUpstreamMarketSub(sub: { type: string; coin?: string; interval?: string }): void };

  constructor(
    server: Server,
    eventBus: EventEmitter,
    worker: { ensureUpstreamMarketSub(sub: { type: string; coin?: string; interval?: string }): void },
  ) {
    this.eventBus = eventBus;
    this.worker = worker;

    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
      this.handleConnection(ws);
    });

    this.setupEventListeners();
    this.startHeartbeat();

    logger.info('WebSocket server attached at /ws');
  }

  private handleConnection(ws: WebSocket): void {
    const state: ClientState = {
      ws,
      subscriptions: new Set(),
      isAlive: true,
      missedHeartbeats: 0,
    };
    this.clients.set(ws, state);

    ws.on('pong', () => {
      state.isAlive = true;
      state.missedHeartbeats = 0;
    });

    ws.on('message', (raw: Buffer) => {
      this.handleMessage(state, raw);
    });

    ws.on('close', () => {
      this.handleDisconnect(state);
    });

    ws.on('error', (err) => {
      logger.warn({ err }, 'WebSocket client error');
      this.handleDisconnect(state);
    });
  }

  private async handleMessage(state: ClientState, raw: Buffer): Promise<void> {
    let msg: {
      method?: string;
      subscription?: WsSubscription;
      id?: number;
      request?: { type?: 'info' | 'action'; payload?: unknown };
    };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this.send(state.ws, { error: 'Invalid JSON' });
      return;
    }

    switch (msg.method) {
      case 'subscribe':
        if (msg.subscription) await this.handleSubscribe(state, msg.subscription);
        else this.send(state.ws, { error: 'Missing subscription' });
        break;
      case 'unsubscribe':
        if (msg.subscription) this.handleUnsubscribe(state, msg.subscription);
        else this.send(state.ws, { error: 'Missing subscription' });
        break;
      // HL keepalive: client sends {"method":"ping"} on a <60s cadence and
      // expects {"channel":"pong"}. (Native ws ping frames still run too via
      // the heartbeat, but HL SDK clients use this app-level form.)
      case 'ping':
        this.send(state.ws, { channel: 'pong' });
        break;
      // HL post requests: tunnel an info/action over the socket.
      //   {"method":"post","id":N,"request":{"type":"info"|"action","payload":{…}}}
      case 'post':
        await this.handlePost(state, msg.id, msg.request);
        break;
      default:
        this.send(state.ws, { error: `Unknown method: ${msg.method}` });
    }
  }

  /** Tunnel an info/action request over WS by replaying it through the same
   *  Hono routes the HTTP API uses, then reply on the `post` channel —
   *  matching HL's `{ channel:'post', data:{ id, response:{ type, payload } } }`. */
  private async handlePost(
    state: ClientState,
    id: number | undefined,
    request: { type?: 'info' | 'action'; payload?: unknown } | undefined,
  ): Promise<void> {
    if (typeof id !== 'number' || !request || (request.type !== 'info' && request.type !== 'action')) {
      this.send(state.ws, { channel: 'post', data: { id: id ?? null, response: { type: 'error', payload: 'post requires id and request.{type:info|action, payload}' } } });
      return;
    }
    const path = request.type === 'info' ? '/info' : '/exchange';
    try {
      const res = await app.fetch(new Request(`http://hypaper.local${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.payload ?? {}),
      }));
      const payload = await res.json();
      this.send(state.ws, {
        channel: 'post',
        data: { id, response: { type: res.ok ? request.type : 'error', payload } },
      });
    } catch (err) {
      this.send(state.ws, { channel: 'post', data: { id, response: { type: 'error', payload: String(err) } } });
    }
  }

  private async handleSubscribe(state: ClientState, sub: WsSubscription): Promise<void> {
    const key = this.subscriptionKey(sub);
    if (!key) {
      this.send(state.ws, { error: 'Invalid subscription' });
      return;
    }

    state.subscriptions.add(key);
    if (!this.subscriptionIndex.has(key)) {
      this.subscriptionIndex.set(key, new Set());
    }
    this.subscriptionIndex.get(key)!.add(state.ws);

    this.send(state.ws, { channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: sub } });

    // Market feeds: ask the worker to subscribe upstream to HL (deduped) so
    // we start receiving + relaying those frames. The sub object is the same
    // shape HL expects ({type, coin[, interval]}).
    if (sub.type === 'trades' || sub.type === 'bbo' || sub.type === 'candle' || sub.type === 'activeAssetCtx') {
      this.worker.ensureUpstreamMarketSub(sub);
    }

    // Send snapshot for allMids
    if (sub.type === 'allMids') {
      const mids = await redis.hgetall(KEYS.MARKET_MIDS);
      if (Object.keys(mids).length > 0) {
        this.send(state.ws, { channel: 'allMids', data: { mids } });
      }
    }

    // Send snapshot for l2Book
    if (sub.type === 'l2Book') {
      const l2Raw = await redis.get(KEYS.MARKET_L2(sub.coin));
      if (l2Raw) {
        const l2 = JSON.parse(l2Raw);
        this.send(state.ws, { channel: 'l2Book', data: { coin: l2.coin, levels: l2.levels, time: l2.time } });
      }
    }

    // Send snapshot for webData2 (combined user state).
    if (sub.type === 'webData2' && sub.user) {
      await this.sendWebData2(state.ws, sub.user.toLowerCase());
    }

    // ── User-feed snapshots (1.2c), sourced from paper state ──
    // userFills snapshot — mirrors live HL, which emits an `isSnapshot:true`
    // fill-history frame on subscribe (verified against wss://api.hyperliquid.xyz/ws).
    // Without this, a freshly-connected client sees an empty Trade History
    // until the next fill arrives. Same fills source the REST `userFills`
    // info endpoint uses (engine/fill.ts:getUserFills).
    if (sub.type === 'userFills' && sub.user) {
      const u = sub.user.toLowerCase();
      const fills = await getUserFills(u);
      this.send(state.ws, { channel: 'userFills', data: { isSnapshot: true, user: u, fills } });
    }
    if (sub.type === 'userFundings' && sub.user) {
      const u = sub.user.toLowerCase();
      const rows = await getUserFundingPg(u, 0);
      // WS funding element is FLAT (no hash/delta wrapper).
      const fundings = rows.map((r) => ({
        time: r.time, coin: r.delta.coin, usdc: r.delta.usdc,
        szi: r.delta.szi, fundingRate: r.delta.fundingRate, nSamples: r.delta.nSamples,
      }));
      this.send(state.ws, { channel: 'userFundings', data: { isSnapshot: true, user: u, fundings } });
    }
    if (sub.type === 'userNonFundingLedgerUpdates' && sub.user) {
      const u = sub.user.toLowerCase();
      const updates = await getLedgerUpdatesPg(u, 0);
      this.send(state.ws, { channel: 'userNonFundingLedgerUpdates', data: { isSnapshot: true, user: u, nonFundingLedgerUpdates: updates } });
    }
    if (sub.type === 'activeAssetData' && sub.user && sub.coin) {
      this.send(state.ws, { channel: 'activeAssetData', data: await getActiveAssetData(sub.user.toLowerCase(), sub.coin) });
    }

    // ── Per-dex user snapshots ──
    // HL fires an initial snapshot on subscribe for these. Match that so the
    // BottomPanel doesn't sit empty for an unbounded time after switching to
    // paper mode.
    if (sub.type === 'clearinghouseState' && sub.user && sub.dex) {
      await this.sendClearinghouseStateForDex(state.ws, sub.user.toLowerCase(), sub.dex);
    }
    if (sub.type === 'openOrders' && sub.user && sub.dex) {
      await this.sendOpenOrdersForDex(state.ws, sub.user.toLowerCase(), sub.dex);
    }
    if (sub.type === 'allDexsClearinghouseState' && sub.user) {
      await this.sendAllDexsClearinghouseState(state.ws, sub.user.toLowerCase());
    }
    // userEvents has no snapshot — HL pushes it live-only.
  }

  // ── Per-dex push helpers ─────────────────────────────────────────────────
  // `getClearinghouseState` / `getFrontendOpenOrders` are now scope-aware
  // (scope==='' → native, scope==='xyz' → xyz subaccount). The push body
  // shape matches HL: payload carries `dex` so the client can route the
  // push to its per-dex listener without ambiguity.

  private async sendClearinghouseStateForDex(ws: WebSocket, user: string, dex: string): Promise<void> {
    try {
      const chs = await getClearinghouseState(user, dex);
      this.send(ws, { channel: 'clearinghouseState', data: { dex, user, clearinghouseState: chs } });
    } catch (err) { logger.warn({ err, user, dex }, 'clearinghouseState snapshot failed'); }
  }

  private async sendOpenOrdersForDex(ws: WebSocket, user: string, dex: string): Promise<void> {
    try {
      // Use the rich frontendOpenOrders shape on the wire — verified upstream
      // that HL's openOrders WS push carries the full rich payload
      // (orderType/isTrigger/triggerPx/etc), not the trimmed `WsBasicOrder`.
      const orders = await getFrontendOpenOrders(user, dex);
      this.send(ws, { channel: 'openOrders', data: { dex, user, orders } });
    } catch (err) { logger.warn({ err, user, dex }, 'openOrders snapshot failed'); }
  }

  private async sendAllDexsClearinghouseState(ws: WebSocket, user: string): Promise<void> {
    try {
      const perpDexsRaw = await redis.get(KEYS.MARKET_PERPDEXS);
      const dexNames: string[] = perpDexsRaw
        ? (JSON.parse(perpDexsRaw) as Array<{ name?: string } | null>)
            .map((d) => d?.name).filter((n): n is string => typeof n === 'string')
        : [];
      const entries: Array<[string, unknown]> = [];
      entries.push(['', await getClearinghouseState(user, '')]);
      for (const d of dexNames) entries.push([d, await getClearinghouseState(user, d)]);
      this.send(ws, { channel: 'allDexsClearinghouseState', data: { user, clearinghouseStates: entries } });
    } catch (err) { logger.warn({ err, user }, 'allDexsClearinghouseState snapshot failed'); }
  }

  /** Broadcast per-dex user state to any matching subscribers. Called from
   *  the order/fill event listeners after a write so dex-subbed clients
   *  see updates without polling. Mirrors `broadcastWebData2`. */
  private async broadcastDexUserState(user: string, dex: string): Promise<void> {
    const u = user.toLowerCase();
    const chsKey = `clearinghouseState:${u}:${dex}`;
    const ooKey  = `openOrders:${u}:${dex}`;
    const allKey = `allDexsClearinghouseState:${u}`;

    const chsSubs = this.subscriptionIndex.get(chsKey);
    const ooSubs  = this.subscriptionIndex.get(ooKey);
    const allSubs = this.subscriptionIndex.get(allKey);

    if ((!chsSubs || chsSubs.size === 0) && (!ooSubs || ooSubs.size === 0) && (!allSubs || allSubs.size === 0)) return;

    try {
      if (chsSubs && chsSubs.size > 0) {
        const chs = await getClearinghouseState(u, dex);
        const json = JSON.stringify({ channel: 'clearinghouseState', data: { dex, user: u, clearinghouseState: chs } });
        for (const ws of chsSubs) if (ws.readyState === WebSocket.OPEN) ws.send(json);
      }
      if (ooSubs && ooSubs.size > 0) {
        const orders = await getFrontendOpenOrders(u, dex);
        const json = JSON.stringify({ channel: 'openOrders', data: { dex, user: u, orders } });
        for (const ws of ooSubs) if (ws.readyState === WebSocket.OPEN) ws.send(json);
      }
      if (allSubs && allSubs.size > 0) {
        const perpDexsRaw = await redis.get(KEYS.MARKET_PERPDEXS);
        const dexNames: string[] = perpDexsRaw
          ? (JSON.parse(perpDexsRaw) as Array<{ name?: string } | null>)
              .map((d) => d?.name).filter((n): n is string => typeof n === 'string')
          : [];
        const entries: Array<[string, unknown]> = [];
        entries.push(['', await getClearinghouseState(u, '')]);
        for (const d of dexNames) entries.push([d, await getClearinghouseState(u, d)]);
        const json = JSON.stringify({ channel: 'allDexsClearinghouseState', data: { user: u, clearinghouseStates: entries } });
        for (const ws of allSubs) if (ws.readyState === WebSocket.OPEN) ws.send(json);
      }
    } catch (err) {
      logger.warn({ err, user: u, dex }, 'per-dex broadcast failed');
    }
  }

  /** Build + send a webData2 snapshot for `user`. Used both on
   *  initial subscribe AND on every fill/orderUpdate event so
   *  subscribers get fresh state without polling. */
  private async sendWebData2(ws: WebSocket, user: string): Promise<void> {
    try {
      const [clearinghouseState, openOrders] = await Promise.all([
        getClearinghouseState(user),
        getFrontendOpenOrders(user),
      ]);
      this.send(ws, {
        channel: 'webData2',
        data: { user, clearinghouseState, openOrders, serverTime: Date.now() },
      });
    } catch (err) {
      logger.warn({ err, user }, 'webData2 build failed');
    }
  }

  /** Broadcast webData2 to every subscriber for `user`. Called from
   *  fill / orderUpdate event listeners so user state stays live. */
  private async broadcastWebData2(user: string): Promise<void> {
    const key = `webData2:${user.toLowerCase()}`;
    const subs = this.subscriptionIndex.get(key);
    if (!subs || subs.size === 0) return;
    try {
      const [clearinghouseState, openOrders] = await Promise.all([
        getClearinghouseState(user),
        getFrontendOpenOrders(user),
      ]);
      const json = JSON.stringify({
        channel: 'webData2',
        data: { user: user.toLowerCase(), clearinghouseState, openOrders, serverTime: Date.now() },
      });
      for (const ws of subs) {
        if (ws.readyState === WebSocket.OPEN) ws.send(json);
      }
    } catch (err) {
      logger.warn({ err, user }, 'webData2 broadcast failed');
    }
  }

  private handleUnsubscribe(state: ClientState, sub: WsSubscription): void {
    const key = this.subscriptionKey(sub);
    if (!key) return;

    state.subscriptions.delete(key);
    this.subscriptionIndex.get(key)?.delete(state.ws);

    this.send(state.ws, { channel: 'subscriptionResponse', data: { method: 'unsubscribe', subscription: sub } });
  }

  private handleDisconnect(state: ClientState): void {
    for (const key of state.subscriptions) {
      this.subscriptionIndex.get(key)?.delete(state.ws);
    }
    this.clients.delete(state.ws);
  }

  private subscriptionKey(sub: WsSubscription): string | null {
    switch (sub.type) {
      case 'allMids':
        return 'allMids';
      case 'l2Book':
        return sub.coin ? `l2Book:${sub.coin}` : null;
      case 'orderUpdates':
        return sub.user ? `orderUpdates:${sub.user}` : null;
      case 'userFills':
        return sub.user ? `userFills:${sub.user}` : null;
      case 'webData2':
        return sub.user ? `webData2:${sub.user.toLowerCase()}` : null;
      // Market feeds (1.2b)
      case 'trades':
        return sub.coin ? `trades:${sub.coin}` : null;
      case 'bbo':
        return sub.coin ? `bbo:${sub.coin}` : null;
      case 'candle':
        return sub.coin && sub.interval ? `candle:${sub.coin}:${sub.interval}` : null;
      case 'activeAssetCtx':
        return sub.coin ? `activeAssetCtx:${sub.coin}` : null;
      case 'notification':
        return sub.user ? `notification:${sub.user.toLowerCase()}` : null;
      // User feeds (1.2c)
      case 'userEvents':
        return sub.user ? `userEvents:${sub.user.toLowerCase()}` : null;
      case 'userFundings':
        return sub.user ? `userFundings:${sub.user.toLowerCase()}` : null;
      case 'userNonFundingLedgerUpdates':
        return sub.user ? `userNonFundingLedgerUpdates:${sub.user.toLowerCase()}` : null;
      case 'activeAssetData':
        return sub.user && sub.coin ? `activeAssetData:${sub.user.toLowerCase()}:${sub.coin}` : null;
      // Per-dex user subs. The dex field is part of the key so each per-dex
      // listener fires only for its own dex's pushes — slushy's hlClient.ts
      // had the same fanout bug and we fixed it client-side; doing the same
      // server-side guarantees one push = one keyed broadcast.
      case 'clearinghouseState':
        return sub.user && sub.dex ? `clearinghouseState:${sub.user.toLowerCase()}:${sub.dex}` : null;
      case 'openOrders':
        return sub.user && sub.dex ? `openOrders:${sub.user.toLowerCase()}:${sub.dex}` : null;
      case 'allDexsClearinghouseState':
        return sub.user ? `allDexsClearinghouseState:${sub.user.toLowerCase()}` : null;
      default:
        return null;
    }
  }

  private setupEventListeners(): void {
    this.eventBus.on('mids', (event: MidsEvent) => {
      const json = JSON.stringify({ channel: 'allMids', data: { mids: event.mids } });
      this.broadcast('allMids', json);
    });

    this.eventBus.on('l2book', (event: L2BookEvent) => {
      const json = JSON.stringify({
        channel: 'l2Book',
        data: { coin: event.coin, levels: event.levels, time: event.time },
      });
      this.broadcast(`l2Book:${event.coin}`, json);
    });

    this.eventBus.on('fill', (event: FillEvent) => {
      const json = JSON.stringify({
        channel: 'userFills',
        data: { isSnapshot: false, user: event.userId, fills: [event.fill] },
      });
      this.broadcast(`userFills:${event.userId}`, json);
      // userEvents (channel "user") carries fills as one of its variants.
      this.broadcast(`userEvents:${event.userId}`, JSON.stringify({ channel: 'user', data: { fills: [event.fill] } }));
      // Fills change the user's positions + open orders → push fresh
      // webData2 snapshot + activeAssetData (maxTradeSzs/availableToTrade move).
      void this.broadcastWebData2(event.userId);
      void this.repushActiveAssetData(event.userId);
      // Sub-dex coins look like "xyz:CRWV" — when a fill is on a sub-dex,
      // push the per-dex CHS + openOrders + allDexs aggregate to any
      // subscribers. Native fills don't touch the dex subs (the `coin`
      // has no colon), so this branch is a no-op for native.
      const colon = event.fill?.coin?.indexOf(':');
      if (typeof colon === 'number' && colon > 0) {
        const dex = event.fill.coin.slice(0, colon);
        void this.broadcastDexUserState(event.userId, dex);
      }
    });

    this.eventBus.on('orderUpdate', (event: OrderUpdateEvent) => {
      const order = event.order;
      const json = JSON.stringify({
        channel: 'orderUpdates',
        data: [{
          order: {
            coin: order.coin,
            side: order.isBuy ? 'B' : 'A',
            limitPx: order.limitPx,
            sz: order.sz,
            oid: order.oid,
            timestamp: order.createdAt,
            origSz: order.sz,
            cloid: order.cloid,
          },
          status: event.status,
          statusTimestamp: order.updatedAt,
        }],
      });
      this.broadcast(`orderUpdates:${event.userId}`, json);
      // Open-order list changed → push webData2 too.
      void this.broadcastWebData2(event.userId);
      // Sub-dex order — fan out per-dex pushes too. Same colon-split as the
      // fill branch above.
      const colon = order.coin?.indexOf(':');
      if (typeof colon === 'number' && colon > 0) {
        const dex = order.coin.slice(0, colon);
        void this.broadcastDexUserState(event.userId, dex);
      }
    });

    // ── Market feeds relayed verbatim from HL (1.2b) ──
    this.eventBus.on('trades', (e: { coin: string; trades: unknown[] }) => {
      this.broadcast(`trades:${e.coin}`, JSON.stringify({ channel: 'trades', data: e.trades }));
    });
    // Engine actions that change account state without a fill/order hook
    // (updateIsolatedMargin / topUpIsolatedOnlyMargin) fire accountUpdate so
    // the client sees fresh marginUsed + liqPx without waiting for a poll.
    this.eventBus.on('accountUpdate', (event: AccountUpdateEvent) => {
      void this.broadcastWebData2(event.userId);
    });
    this.eventBus.on('bbo', (e: { coin: string; frame: unknown }) => {
      this.broadcast(`bbo:${e.coin}`, JSON.stringify({ channel: 'bbo', data: e.frame }));
    });
    this.eventBus.on('candle', (e: { coin: string; interval: string; frame: unknown }) => {
      this.broadcast(`candle:${e.coin}:${e.interval}`, JSON.stringify({ channel: 'candle', data: e.frame }));
    });
    this.eventBus.on('activeAssetCtx', (e: { coin: string; ctx: unknown }) => {
      this.broadcast(`activeAssetCtx:${e.coin}`, JSON.stringify({ channel: 'activeAssetCtx', data: { coin: e.coin, ctx: e.ctx } }));
    });

    // ── User feeds sourced from paper state (1.2c) ──
    this.eventBus.on('funding', (e: { userId: string; funding: unknown }) => {
      this.broadcast(`userFundings:${e.userId}`, JSON.stringify({ channel: 'userFundings', data: { isSnapshot: false, user: e.userId, fundings: [e.funding] } }));
      this.broadcast(`userEvents:${e.userId}`, JSON.stringify({ channel: 'user', data: { funding: e.funding } }));
    });
    this.eventBus.on('ledger', (e: { userId: string; update: unknown }) => {
      this.broadcast(`userNonFundingLedgerUpdates:${e.userId}`, JSON.stringify({ channel: 'userNonFundingLedgerUpdates', data: { isSnapshot: false, user: e.userId, nonFundingLedgerUpdates: [e.update] } }));
    });
  }

  /** Recompute + push activeAssetData for every (user, coin) the given user
   *  is subscribed to. Called on fills (positions/leverage move maxTradeSzs). */
  private async repushActiveAssetData(userId: string): Promise<void> {
    const prefix = `activeAssetData:${userId.toLowerCase()}:`;
    for (const key of this.subscriptionIndex.keys()) {
      if (!key.startsWith(prefix)) continue;
      const subs = this.subscriptionIndex.get(key);
      if (!subs || subs.size === 0) continue;
      const coin = key.slice(prefix.length);
      try {
        this.broadcast(key, JSON.stringify({ channel: 'activeAssetData', data: await getActiveAssetData(userId.toLowerCase(), coin) }));
      } catch (err) {
        logger.warn({ err, userId, coin }, 'activeAssetData repush failed');
      }
    }
  }

  private broadcast(key: string, json: string): void {
    const subs = this.subscriptionIndex.get(key);
    if (!subs || subs.size === 0) return;

    for (const ws of subs) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  }

  private send(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [ws, state] of this.clients) {
        if (!state.isAlive) {
          state.missedHeartbeats += 1;
          if (state.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
            logger.warn(
              { missed: state.missedHeartbeats, subs: state.subscriptions.size },
              'heartbeat timeout — terminating client (was missing pongs)',
            );
            ws.terminate();
            this.handleDisconnect(state);
            continue;
          }
          // Don't ping again — wait for the prior ping's pong to arrive.
          // Just bump the counter and try again next cycle.
          continue;
        }
        state.isAlive = false;
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL);
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [ws] of this.clients) {
      ws.terminate();
    }
    this.clients.clear();
    this.subscriptionIndex.clear();
    this.wss.close();
  }
}
