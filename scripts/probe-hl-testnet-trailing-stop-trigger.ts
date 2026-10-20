/**
 * probe-hl-testnet-trailing-stop-trigger.ts
 *
 * PURPOSE: Round 2 of the trailing-stop probe. Round 1
 * (probe-hl-testnet-trailing-stop.ts) captured placement / query / cancel
 * shapes but never saw a stop FIRE or ACTIVATE. This probe captures:
 *
 *   T3  Odd case: CLOSE-long stop with activation BELOW mark — is it active
 *       immediately? (frontendOpenOrders right after placing)
 *   T2  Activation transition: CLOSE-long stop with activation a few $ ABOVE
 *       mark — triggerCondition / triggerPx before vs after activation.
 *   T1  Trigger firing: CLOSE-long stop with a very tight retracement —
 *       final orderStatus string, fill oid (new vs original), userFills
 *       entry, last triggerCondition before firing.
 *   WS  orderUpdates + userFills websocket events across the whole run.
 *
 * ORDER: T3 and T2 use a wide retracement so they cannot fire; T1 runs LAST
 * because its fill closes the test position.
 *
 * SETUP — .env must have:
 *   HL_TESTNET_PRIVATE_KEY=0x...
 *   HL_TESTNET_WALLET=0x...
 *
 * RUN:
 *   npx tsx scripts/probe-hl-testnet-trailing-stop-trigger.ts
 *
 * OPTIONAL ENV:
 *   PROBE_COIN=BTC            coin (default BTC)
 *   POLL_S=5                  poll interval seconds (default 5; keeps us
 *                             under HL's 1200 weight/min IP limit)
 *   TRIGGER_TIMEOUT_S=300     max wait for T1 to fire
 *   ACTIVATION_TIMEOUT_S=240  max wait for T2 to activate
 *   DRY_RUN=1                 build + sign + print, send nothing
 *
 * OUTPUT: scripts/captures/31_trigger_*.json  (+ trigger-run-summary.json)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { keccak256, toHex } from 'viem';
import { config as dotenvConfig } from 'dotenv';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '../.env') });

// ─── Config ───────────────────────────────────────────────────────────────────

const TESTNET_API  = 'https://api.hyperliquid-testnet.xyz';
const EXCHANGE_URL = `${TESTNET_API}/exchange`;
const INFO_URL     = `${TESTNET_API}/info`;
const WS_URL       = 'wss://api.hyperliquid-testnet.xyz/ws';
const CAPTURES_DIR = resolve(__dirname, 'captures');

const COIN                 = process.env.PROBE_COIN ?? 'BTC';
const POLL_S               = Number(process.env.POLL_S ?? 5);
const TRIGGER_TIMEOUT_S    = Number(process.env.TRIGGER_TIMEOUT_S ?? 300);
const ACTIVATION_TIMEOUT_S = Number(process.env.ACTIVATION_TIMEOUT_S ?? 240);
const DRY_RUN              = process.env.DRY_RUN === '1';

const PRIVATE_KEY = process.env.HL_TESTNET_PRIVATE_KEY as `0x${string}` | undefined;
const WALLET_ADDR = process.env.HL_TESTNET_WALLET      as `0x${string}` | undefined;

// TESTNET-ONLY GUARD. Hard stop if any endpoint is anything but testnet.
for (const url of [EXCHANGE_URL, INFO_URL, WS_URL]) {
  if (!/^(https|wss):\/\/api\.hyperliquid-testnet\.xyz\//.test(url)) {
    throw new Error(`REFUSING TO RUN: ${url} is not the Hyperliquid TESTNET API`);
  }
}

if (!PRIVATE_KEY || !WALLET_ADDR) {
  console.error('ERROR: Set HL_TESTNET_PRIVATE_KEY and HL_TESTNET_WALLET in .env');
  process.exit(1);
}

// ─── EIP-712 ─────────────────────────────────────────────────────────────────

const HL_EIP712_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const;

const AGENT_TYPES = {
  Agent: [
    { name: 'source',       type: 'string'  },
    { name: 'connectionId', type: 'bytes32' },
  ],
} as const;

// ─── Signing ─────────────────────────────────────────────────────────────────

function actionHash(action: unknown, nonce: number): `0x${string}` {
  const packed     = msgpackEncode(action);
  const nonceBuf   = new ArrayBuffer(8);
  new DataView(nonceBuf).setBigUint64(0, BigInt(nonce), false);
  const nonceBytes = new Uint8Array(nonceBuf);
  const vaultFlag  = new Uint8Array([0]);
  const combined   = new Uint8Array(packed.length + nonceBytes.length + vaultFlag.length);
  combined.set(packed,     0);
  combined.set(nonceBytes, packed.length);
  combined.set(vaultFlag,  packed.length + nonceBytes.length);
  return keccak256(toHex(combined));
}

async function signL1Action(
  account: ReturnType<typeof privateKeyToAccount>,
  action: unknown,
  nonce: number,
): Promise<{ r: `0x${string}`; s: `0x${string}`; v: number }> {
  const connectionId = actionHash(action, nonce);
  const sig = await account.signTypedData({
    domain:      HL_EIP712_DOMAIN,
    types:       AGENT_TYPES,
    primaryType: 'Agent',
    message:     { source: 'b', connectionId }, // 'b' = testnet
  });
  return {
    r: `0x${sig.slice(2,   66)}`  as `0x${string}`,
    s: `0x${sig.slice(66, 130)}`  as `0x${string}`,
    v: parseInt(sig.slice(130, 132), 16),
  };
}

// ─── Formatters ───────────────────────────────────────────────────────────────

/** HL perp price rule: max 5 sig figs AND at most (6 - szDecimals) decimals. */
function fmtPx(price: number, szDecimals: number): string {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const sig = parseFloat(price.toPrecision(5));
  return parseFloat(sig.toFixed(maxDecimals)).toString();
}

function fmtSz(size: number, szDecimals: number): string {
  return parseFloat(size.toFixed(szDecimals)).toString();
}

// ─── Action builders ──────────────────────────────────────────────────────────
// Field order MUST match HL exactly — msgpack is order-sensitive.

type Retracement = { px: string } | { pct: string };

function wire(asset: number, isBuy: boolean, price: string, size: string, reduceOnly: boolean, tif: 'Gtc' | 'Ioc' | 'Alo') {
  return { a: asset, b: isBuy, p: price, s: size, r: reduceOnly, t: { limit: { tif } } };
}
function orderAction(orders: ReturnType<typeof wire>[], grouping = 'na') {
  return { type: 'order', orders, grouping };
}
function cancelAction(cancels: Array<{ a: number; o: number }>) {
  return { type: 'cancel', cancels };
}
function trailingStopAction(
  asset: number, isBuy: boolean, size: string, reduceOnly: boolean,
  retracement: Retracement, activationPx: string | null,
) {
  // Order verified in round 1 by offline signer recovery against UI captures.
  return { type: 'trailingStop', asset, isBuy, sz: size, reduceOnly, retracement, activationPx };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function save(filename: string, data: Record<string, unknown>) {
  mkdirSync(CAPTURES_DIR, { recursive: true });
  writeFileSync(resolve(CAPTURES_DIR, filename), JSON.stringify(data, null, 2));
  console.log(`  ✅ Saved: scripts/captures/${filename}`);
}

interface ExchangeResult {
  requestBody: unknown;
  httpStatus:  number | null;
  rawBody:     string | null;
  response:    unknown;
  meta: { nonce: number; msgpackHex: string; connectionId: string; signature: unknown };
}

async function doExchange(
  account: ReturnType<typeof privateKeyToAccount>,
  action: unknown,
): Promise<ExchangeResult> {
  const nonce     = Date.now();
  const signature = await signL1Action(account, action, nonce);
  const body      = { action, nonce, signature };
  const meta = {
    nonce,
    msgpackHex:   toHex(msgpackEncode(action)),
    connectionId: actionHash(action, nonce),
    signature,
  };
  if (DRY_RUN) {
    return { requestBody: body, httpStatus: null, rawBody: null, response: { dryRun: true }, meta };
  }
  const res = await fetch(EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = { nonJson: text.slice(0, 500) }; }
  return { requestBody: body, httpStatus: res.status, rawBody: text, response: parsed, meta };
}

async function infoPost(query: unknown): Promise<unknown> {
  const res = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { nonJson: text.slice(0, 500), httpStatus: res.status };
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Market / account helpers ─────────────────────────────────────────────────

interface MarketInfo { asset: number; szDecimals: number; markPx: number; oraclePx: number }

async function getMarket(): Promise<MarketInfo> {
  const mac = await infoPost({ type: 'metaAndAssetCtxs' }) as [
    { universe: Array<{ name: string; szDecimals: number }> },
    Array<{ oraclePx: string; markPx: string }>,
  ];
  // Asset index is ALWAYS looked up dynamically — testnet ordering != mainnet.
  const asset = mac[0].universe.findIndex(a => a.name === COIN);
  if (asset === -1) throw new Error(`${COIN} not found in testnet universe`);
  return {
    asset,
    szDecimals: mac[0].universe[asset].szDecimals,
    markPx:     parseFloat(mac[1][asset].markPx),
    oraclePx:   parseFloat(mac[1][asset].oraclePx),
  };
}

async function getPosition(): Promise<{ szi: number; raw: unknown }> {
  const state = await infoPost({ type: 'clearinghouseState', user: WALLET_ADDR }) as any;
  const p = (state?.assetPositions ?? []).find((x: any) => x?.position?.coin === COIN);
  return { szi: p ? parseFloat(p.position.szi) : 0, raw: state };
}

async function getRestingForCoin(): Promise<Array<{ oid: number; raw: any }>> {
  const fo = await infoPost({ type: 'frontendOpenOrders', user: WALLET_ADDR }) as any[];
  return (Array.isArray(fo) ? fo : []).filter(o => o.coin === COIN).map(o => ({ oid: o.oid, raw: o }));
}

function extractOid(response: any): number | null {
  return response?.response?.data?.oid ?? null;
}

// ─── WebSocket recorder (orderUpdates + userFills + userEvents) ───────────────

interface WsEvent { t: string; msg: unknown }

function startWsRecorder(): { events: WsEvent[]; close: () => void; ready: Promise<void> } {
  const events: WsEvent[] = [];
  if (DRY_RUN) return { events, close: () => {}, ready: Promise.resolve() };
  const ws = new WebSocket(WS_URL);
  const ready = new Promise<void>(res => {
    ws.on('open', () => {
      for (const type of ['orderUpdates', 'userFills', 'userEvents']) {
        ws.send(JSON.stringify({ method: 'subscribe', subscription: { type, user: WALLET_ADDR } }));
      }
      res();
    });
    ws.on('error', (e: Error) => { events.push({ t: new Date().toISOString(), msg: { wsError: String(e) } }); res(); });
  });
  ws.on('message', (data: WebSocket.RawData) => {
    let msg: unknown;
    try { msg = JSON.parse(data.toString()); } catch { msg = { raw: data.toString().slice(0, 500) }; }
    events.push({ t: new Date().toISOString(), msg });
  });
  // keep-alive: HL drops idle sockets after ~60s
  const ping = setInterval(() => { try { ws.send(JSON.stringify({ method: 'ping' })); } catch { /* closed */ } }, 30_000);
  return { events, ready, close: () => { clearInterval(ping); try { ws.close(); } catch { /* ignore */ } } };
}

// ─── Order watcher ────────────────────────────────────────────────────────────

interface Tick {
  t: string;
  markPx: number;
  frontend: any | null;      // this oid's frontendOpenOrders entry, null if gone
  orderStatus: any;          // raw orderStatus response
  fillsSinceStart: any[];    // userFills entries with time >= run start
}

async function pollOnce(oid: number, startMs: number): Promise<Tick> {
  const mk = await getMarket();
  const fo = await infoPost({ type: 'frontendOpenOrders', user: WALLET_ADDR }) as any[];
  const st = await infoPost({ type: 'orderStatus', user: WALLET_ADDR, oid });
  const fills = await infoPost({ type: 'userFills', user: WALLET_ADDR }) as any[];
  return {
    t: new Date().toISOString(),
    markPx: mk.markPx,
    frontend: (Array.isArray(fo) ? fo : []).find(o => o.oid === oid) ?? null,
    orderStatus: st,
    fillsSinceStart: (Array.isArray(fills) ? fills : []).filter(f => f.time >= startMs),
  };
}

/** Poll until `done(tick)` is true or timeout. Always returns all ticks. */
async function watch(
  label: string, oid: number, timeoutS: number, startMs: number,
  done: (tick: Tick, prev: Tick | null) => boolean,
): Promise<{ ticks: Tick[]; hit: boolean }> {
  const ticks: Tick[] = [];
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutS) {
    const tick = await pollOnce(oid, startMs);
    const prev = ticks.length ? ticks[ticks.length - 1] : null;
    ticks.push(tick);
    console.log(`  [${label} ${ticks.length}] mark=${tick.markPx}  ${tick.frontend?.triggerCondition ?? '(not in frontendOpenOrders)'}  trig=${tick.frontend?.triggerPx ?? '-'}  status=${tick.orderStatus?.order?.status ?? tick.orderStatus?.status}`);
    if (done(tick, prev)) return { ticks, hit: true };
    await sleep(POLL_S * 1000);
  }
  return { ticks, hit: false };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY!);

  console.log('\n🔬 Hyperliquid Testnet Probe — TRAILING STOP trigger / activation');
  console.log('=================================================================');
  console.log(`Wallet : ${account.address}`);
  console.log(`Mode   : ${DRY_RUN ? 'DRY RUN (nothing sent)' : 'LIVE TESTNET'}`);

  if (account.address.toLowerCase() !== WALLET_ADDR!.toLowerCase()) {
    console.error(`\n❌ Key mismatch. Set HL_TESTNET_WALLET=${account.address}\n`);
    process.exit(1);
  }
  console.log('✅ Key matches.\n');

  const mkt = await getMarket();
  const { asset, szDecimals } = mkt;
  const minSz = 1 / Math.pow(10, szDecimals);
  const sz = fmtSz(Math.ceil(12 / mkt.markPx / minSz) * minSz, szDecimals); // ~$12 notional
  console.log(`  ${COIN} asset=${asset} szDecimals=${szDecimals} mark=$${mkt.markPx}  size=${sz}\n`);

  // Safety: refuse to trample a pre-existing position / resting orders.
  if (!DRY_RUN) {
    const pos = await getPosition();
    const resting = await getRestingForCoin();
    if (pos.szi !== 0 || resting.length > 0) {
      console.error(`❌ Wallet already has ${COIN} position (szi=${pos.szi}) or ${resting.length} resting order(s).`);
      console.error('   Clear them first so this probe\'s cleanup cannot touch unrelated state.');
      process.exit(1);
    }
  }

  const runStartMs = Date.now();
  const ws = startWsRecorder();
  await ws.ready;

  const summary: Record<string, unknown> = {
    coin: COIN, asset, sz, startedAt: new Date().toISOString(), dryRun: DRY_RUN,
  };

  try {
    // ── Setup: open a small long ─────────────────────────────────────────────
    console.log('📤 Setup: open long via IOC buy through the book...');
    const e = await doExchange(account, orderAction([wire(asset, true, fmtPx(mkt.markPx * 1.02, szDecimals), sz, false, 'Ioc')]));
    save('31_trigger_00_setup_long.json', { request: e.requestBody, response: e.response, httpStatus: e.httpStatus, meta: e.meta });
    console.log('  Response:', JSON.stringify(e.response));
    if (!DRY_RUN && !(e.response as any)?.response?.data?.statuses?.[0]?.filled) {
      throw new Error('Setup long did not fill — see 31_trigger_00_setup_long.json');
    }
    await sleep(800);

    // Helper: place a stop, save the placement + immediate frontendOpenOrders.
    async function placeStop(slug: string, label: string, action: ReturnType<typeof trailingStopAction>) {
      console.log(`\n📤 ${label}`);
      const r = await doExchange(account, action);
      // Query IMMEDIATELY (no sleep) so we see the very first state.
      const immediate = DRY_RUN ? null : await infoPost({ type: 'frontendOpenOrders', user: WALLET_ADDR });
      const oid = extractOid(r.response);
      const immediateStatus = DRY_RUN || oid === null ? null : await infoPost({ type: 'orderStatus', user: WALLET_ADDR, oid });
      console.log(`  HTTP ${r.httpStatus}  ${JSON.stringify(r.response)}`);
      save(`31_trigger_${slug}_place.json`, {
        label, request: r.requestBody, response: r.response, httpStatus: r.httpStatus, rawBody: r.rawBody, meta: r.meta,
        immediateFrontendOpenOrders: immediate, immediateOrderStatus: immediateStatus,
      });
      return { oid, r };
    }

    async function cancelStop(slug: string, oid: number) {
      const c = await doExchange(account, cancelAction([{ a: asset, o: oid }]));
      console.log(`  cancel ${oid}:`, JSON.stringify(c.response));
      save(`31_trigger_${slug}_cancel.json`, { request: c.requestBody, response: c.response, httpStatus: c.httpStatus, meta: c.meta });
    }

    // ── T3: close-long stop, activation BELOW mark (odd case) ───────────────
    {
      const m = DRY_RUN ? mkt : await getMarket();
      const act = fmtPx(m.markPx - 25, szDecimals);
      const { oid } = await placeStop('t3_act_below', `T3: CLOSE long, retracement px 3000, activation BELOW mark (${act} vs mark ${m.markPx})`,
        trailingStopAction(asset, false, sz, true, { px: '3000' }, act));
      if (!DRY_RUN && oid !== null) {
        // 4 polls: is it active immediately, and does its state evolve?
        const { ticks } = await watch('T3', oid, POLL_S * 4, runStartMs, () => false);
        save('31_trigger_t3_act_below_poll.json', { activationPx: act, ticks });
        (summary as any).t3 = { oid, activationPx: act, firstCondition: ticks[0]?.frontend?.triggerCondition, firstTriggerPx: ticks[0]?.frontend?.triggerPx };
        await cancelStop('t3_act_below', oid);
        await sleep(800);
      }
    }

    // ── T2: activation transition (activation a few $ ABOVE mark) ───────────
    {
      const m = DRY_RUN ? mkt : await getMarket();
      const act = fmtPx(m.markPx + 6, szDecimals);
      const { oid } = await placeStop('t2_activation', `T2: CLOSE long, retracement px 3000, activation ABOVE mark (${act} vs mark ${m.markPx})`,
        trailingStopAction(asset, false, sz, true, { px: '3000' }, act));
      if (!DRY_RUN && oid !== null) {
        // Activated when the condition text stops saying "waiting".
        const { ticks, hit } = await watch('T2', oid, ACTIVATION_TIMEOUT_S, runStartMs,
          tk => !!tk.frontend && !/waiting/.test(tk.frontend.triggerCondition ?? 'waiting'));
        const firstIdx = ticks.length - 1;
        save('31_trigger_t2_activation_poll.json', {
          activationPx: act, activated: hit, ticks,
          before: hit && firstIdx > 0 ? ticks[firstIdx - 1].frontend : ticks[0]?.frontend,
          after:  hit ? ticks[firstIdx].frontend : null,
        });
        (summary as any).t2 = { oid, activationPx: act, activated: hit, ticksToActivate: hit ? ticks.length : null };
        console.log(hit ? '  ✅ Activation observed.' : '  ⚠️  Not activated within timeout — mark never reached activation price.');
        await cancelStop('t2_activation', oid);
        await sleep(800);
      }
    }

    // ── T1: tight retracement — wait for it to FIRE (runs last) ─────────────
    {
      // Try ever-wider tiny distances until HL accepts one (min is unknown).
      let oid: number | null = null;
      let usedPx = '';
      for (const px of ['5', '10', '20']) {
        const placed = await placeStop(`t1_tight_px${px}`, `T1: CLOSE long, TIGHT retracement px ${px}, no activation`,
          trailingStopAction(asset, false, sz, true, { px }, null));
        oid = placed.oid;
        if (oid !== null) { usedPx = px; break; }
      }
      if (!DRY_RUN && oid !== null) {
        const fireStart = Date.now();
        const { ticks, hit } = await watch('T1', oid, TRIGGER_TIMEOUT_S, runStartMs,
          tk => tk.frontend === null || (tk.orderStatus?.order?.status && tk.orderStatus.order.status !== 'open'));
        console.log(hit ? `  🔥 Stop left the book after ${((Date.now() - fireStart) / 1000).toFixed(0)}s` : '  ⚠️  Did not fire within timeout.');

        // Post-fire captures (wait a moment for fills / ledger to settle).
        await sleep(2500);
        const post = {
          orderStatus:       await infoPost({ type: 'orderStatus', user: WALLET_ADDR, oid }),
          historicalOrders:  await infoPost({ type: 'historicalOrders', user: WALLET_ADDR }),
          userFills:         (await infoPost({ type: 'userFills', user: WALLET_ADDR }) as any[]).filter?.((f: any) => f.time >= runStartMs),
          frontendOpenOrders: await infoPost({ type: 'frontendOpenOrders', user: WALLET_ADDR }),
          clearinghouseState: await infoPost({ type: 'clearinghouseState', user: WALLET_ADDR }),
        };
        const lastOpen = [...ticks].reverse().find(tk => tk.frontend !== null);
        const fillsForStop = (post.userFills ?? []).filter((f: any) => f.oid === oid);
        save('31_trigger_t1_fired.json', {
          fired: hit, retracementPx: usedPx, oid,
          lastTriggerConditionBeforeFire: lastOpen?.frontend?.triggerCondition ?? null,
          lastFrontendEntryBeforeFire: lastOpen?.frontend ?? null,
          fillWithSameOid: fillsForStop.length > 0,
          fillsForStopOid: fillsForStop,
          post, ticks,
        });
        (summary as any).t1 = {
          oid, retracementPx: usedPx, fired: hit, ticks: ticks.length,
          finalOrderStatus: (post.orderStatus as any)?.order?.status ?? null,
          lastTriggerConditionBeforeFire: lastOpen?.frontend?.triggerCondition ?? null,
          fillWithSameOid: fillsForStop.length > 0,
        };
        if (!hit) await cancelStop('t1_tight', oid);
      }
    }
  } finally {
    // ── Cleanup: cancel leftovers on this coin, close the test position ──────
    if (!DRY_RUN) {
      console.log('\n🧹 Cleanup...');
      try {
        const resting = await getRestingForCoin();
        if (resting.length > 0) {
          const c = await doExchange(account, cancelAction(resting.map(o => ({ a: asset, o: o.oid }))));
          console.log(`  Cancelled ${resting.length} leftover order(s):`, JSON.stringify(c.response));
          save('31_trigger_cleanup_cancel.json', { request: c.requestBody, response: c.response, httpStatus: c.httpStatus });
        }
        const pos = await getPosition();
        if (pos.szi > 0) {
          const m = await getMarket();
          const c = await doExchange(account, orderAction([wire(asset, false, fmtPx(m.markPx * 0.98, szDecimals), fmtSz(pos.szi, szDecimals), true, 'Ioc')]));
          console.log('  Closed position:', JSON.stringify(c.response));
          save('31_trigger_cleanup_close.json', { request: c.requestBody, response: c.response, httpStatus: c.httpStatus });
        } else {
          console.log(`  No open ${COIN} long to close (szi=${pos.szi}).`);
        }
        console.log(`  Final ${COIN} szi = ${(await getPosition()).szi}`);
      } catch (err) {
        console.error('  ⚠️  CLEANUP FAILED — check testnet UI manually:', err);
      }
    }
    await sleep(1500); // let trailing ws frames land
    ws.close();
    save('31_trigger_ws_events.json', { count: ws.events.length, events: ws.events });
    summary.finishedAt = new Date().toISOString();
    save('trigger-run-summary.json', summary);
  }

  console.log('\n✅ Done. Captures are in scripts/captures/31_trigger_*.json\n');
}

main().catch(err => {
  console.error('\n❌ Probe failed:', err);
  process.exit(1);
});
