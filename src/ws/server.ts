import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import { getClearinghouseState, getFrontendOpenOrders } from '../engine/position.js';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import type {
  WsSubscription,
  MidsEvent,
  L2BookEvent,
  FillEvent,
  OrderUpdateEvent,
} from './types.js';

interface ClientState {
  ws: WebSocket;
  subscriptions: Set<string>;
  isAlive: boolean;
}

const HEARTBEAT_INTERVAL = 30_000;

export class HyPaperWsServer {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientState>();
  private subscriptionIndex = new Map<string, Set<WebSocket>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private eventBus: EventEmitter;

  constructor(server: Server, eventBus: EventEmitter) {
    this.eventBus = eventBus;

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
    };
    this.clients.set(ws, state);

    ws.on('pong', () => {
      state.isAlive = true;
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
    let msg: { method?: string; subscription?: WsSubscription };
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
      default:
        this.send(state.ws, { error: `Unknown method: ${msg.method}` });
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
      // Fills change the user's positions + open orders → push fresh
      // webData2 snapshot to subscribers.
      void this.broadcastWebData2(event.userId);
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
    });
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
          ws.terminate();
          this.handleDisconnect(state);
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
