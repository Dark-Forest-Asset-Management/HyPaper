/**
 * probe-hl-testnet-trailing-stop-orphan.ts
 *
 * PURPOSE: Round 4 (final) of the trailing-stop probe.
 *
 *   O1  REDUCE-ONLY ORPHAN: open a small long, place a close-long trailing
 *       stop (reduceOnly true, wide retracement so it cannot fire), then close
 *       the position with a normal reduce-only IOC order. Snapshot
 *       frontendOpenOrders / orderStatus / historicalOrders / position right
 *       after, ~10 s later and ~30 s later: is the stop auto-canceled, and with
 *       what status string? Then try to cancel it explicitly (the cancel
 *       response itself shows whether it still existed).
 *   O2  PCT FIRING: reopen a long, place a close-long stop with a tight pct
 *       ("0.0100%" = 0.01 %), capture the fire (final status, fill) and check
 *       triggerPx against best * (1 - rate) on every observed tick.
 *   WS  orderUpdates + userFills + userEvents events across the whole run.
 *
 * The buy-side activation transition is deliberately NOT probed (inferred from
 * the sell side, not observed).
 *
 * SETUP — .env must have:
 *   HL_TESTNET_PRIVATE_KEY=0x...
 *   HL_TESTNET_WALLET=0x...
 *
 * RUN:
 *   npx tsx scripts/probe-hl-testnet-trailing-stop-orphan.ts
 *
 * OPTIONAL ENV: PROBE_COIN, TRIGGER_TIMEOUT_S, DRY_RUN=1
 *
 * OUTPUT: scripts/captures/33_orphan_*.json (+ orphan-run-summary.json)
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

// ─── Lean fast poller (for catching the pre-fire state) ───────────────────────
// Weight per tick ≈ frontendOpenOrders 20 + orderStatus 2 + allMids 2 = 24, so a
// 1-2 s cadence stays at/under HL's 1200 weight/min IP limit.

interface FastTick { t: string; mid: number | null; frontend: any | null; orderStatus: any }

async function fastPoll(oid: number): Promise<FastTick> {
  const [fo, st, mids] = await Promise.all([
    infoPost({ type: 'frontendOpenOrders', user: WALLET_ADDR }) as Promise<any[]>,
    infoPost({ type: 'orderStatus', user: WALLET_ADDR, oid }),
    infoPost({ type: 'allMids' }) as Promise<Record<string, string>>,
  ]);
  return {
    t: new Date().toISOString(),
    mid: mids?.[COIN] ? parseFloat(mids[COIN]) : null,
    frontend: (Array.isArray(fo) ? fo : []).find(o => o.oid === oid) ?? null,
    orderStatus: st,
  };
}

async function watchFast(
  label: string, oid: number, timeoutS: number, intervalMs: number,
  done: (tick: FastTick) => boolean,
): Promise<{ ticks: FastTick[]; hit: boolean }> {
  const ticks: FastTick[] = [];
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutS) {
    const tick = await fastPoll(oid);
    ticks.push(tick);
    console.log(`  [${label} ${ticks.length}] mid=${tick.mid}  ${tick.frontend?.triggerCondition ?? '(not in frontendOpenOrders)'}  trig=${tick.frontend?.triggerPx ?? '-'}  status=${tick.orderStatus?.order?.status ?? tick.orderStatus?.status}`);
    if (done(tick)) return { ticks, hit: true };
    await sleep(intervalMs);
  }
  return { ticks, hit: false };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY!);

  console.log('\n🔬 Hyperliquid Testnet Probe — TRAILING STOP orphan (reduce-only) + pct firing');
  console.log('===============================================================================');
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

  // ── helpers ────────────────────────────────────────────────────────────────

  async function openLong(slug: string) {
    const m = DRY_RUN ? mkt : await getMarket();
    const e = await doExchange(account, orderAction([wire(asset, true, fmtPx(m.markPx * 1.02, szDecimals), sz, false, 'Ioc')]));
    save(`33_orphan_${slug}.json`, { request: e.requestBody, response: e.response, httpStatus: e.httpStatus, meta: e.meta });
    console.log('  Open long:', JSON.stringify(e.response));
    if (!DRY_RUN && !(e.response as any)?.response?.data?.statuses?.[0]?.filled) {
      throw new Error(`Open long did not fill — see 33_orphan_${slug}.json`);
    }
    await sleep(800);
  }

  async function closeLongNormal(slug: string) {
    const pos = await getPosition();
    const m = DRY_RUN ? mkt : await getMarket();
    const szClose = DRY_RUN ? sz : fmtSz(pos.szi, szDecimals);
    const c = await doExchange(account, orderAction([wire(asset, false, fmtPx(m.markPx * 0.98, szDecimals), szClose, true, 'Ioc')]));
    save(`33_orphan_${slug}.json`, { request: c.requestBody, response: c.response, httpStatus: c.httpStatus, meta: c.meta });
    console.log('  Normal reduce-only IOC close:', JSON.stringify(c.response));
    return c;
  }

  async function placeStop(slug: string, label: string, action: ReturnType<typeof trailingStopAction>) {
    console.log(`\n📤 ${label}`);
    const r = await doExchange(account, action);
    const immediate = DRY_RUN ? null : await infoPost({ type: 'frontendOpenOrders', user: WALLET_ADDR });
    const oid = extractOid(r.response);
    const immediateStatus = DRY_RUN || oid === null ? null : await infoPost({ type: 'orderStatus', user: WALLET_ADDR, oid });
    console.log(`  HTTP ${r.httpStatus}  ${JSON.stringify(r.response)}`);
    save(`33_orphan_${slug}_place.json`, {
      label, request: r.requestBody, response: r.response, httpStatus: r.httpStatus, rawBody: r.rawBody, meta: r.meta,
      immediateFrontendOpenOrders: immediate, immediateOrderStatus: immediateStatus,
    });
    return { oid, r };
  }

  async function snapshot(oid: number) {
    const hist = await infoPost({ type: 'historicalOrders', user: WALLET_ADDR }) as any[];
    const pos = await getPosition();
    return {
      t: new Date().toISOString(),
      frontendOpenOrders: await infoPost({ type: 'frontendOpenOrders', user: WALLET_ADDR }),
      openOrders:         await infoPost({ type: 'openOrders', user: WALLET_ADDR }),
      orderStatus:        await infoPost({ type: 'orderStatus', user: WALLET_ADDR, oid }),
      historicalOrdersForOid: (Array.isArray(hist) ? hist : []).filter(h => h?.order?.oid === oid),
      positionSzi:        pos.szi,
    };
  }

  try {
    // ── O1: reduce-only orphan ───────────────────────────────────────────────
    console.log('📤 O1 setup: open long...');
    await openLong('o1_00_open_long');

    const m1 = DRY_RUN ? mkt : await getMarket();
    const { oid: orphanOid } = await placeStop('o1_stop', 'O1: CLOSE long stop, retracement px 3000 (wide, cannot fire), reduceOnly true',
      trailingStopAction(asset, false, sz, true, { px: '3000' }, null));
    void m1;

    if (!DRY_RUN && orphanOid !== null) {
      const before = await snapshot(orphanOid);
      save('33_orphan_o1_before_close_snapshot.json', before as unknown as Record<string, unknown>);

      console.log('\n📤 O1: close the position with a NORMAL reduce-only IOC order (stop is now orphaned)...');
      await closeLongNormal('o1_01_normal_close');

      const snaps: Record<string, unknown> = {};
      await sleep(1200);
      snaps.after_0s = await snapshot(orphanOid);
      const s0 = snaps.after_0s as any;
      console.log(`  +~1s : szi=${s0.positionSzi}  orderStatus=${s0.orderStatus?.order?.status ?? s0.orderStatus?.status}  inFrontendOpenOrders=${(s0.frontendOpenOrders as any[]).some(o => o.oid === orphanOid)}`);
      await sleep(10_000);
      snaps.after_10s = await snapshot(orphanOid);
      const s10 = snaps.after_10s as any;
      console.log(`  +~11s: szi=${s10.positionSzi}  orderStatus=${s10.orderStatus?.order?.status ?? s10.orderStatus?.status}  inFrontendOpenOrders=${(s10.frontendOpenOrders as any[]).some(o => o.oid === orphanOid)}`);
      await sleep(20_000);
      snaps.after_30s = await snapshot(orphanOid);
      const s30 = snaps.after_30s as any;
      console.log(`  +~31s: szi=${s30.positionSzi}  orderStatus=${s30.orderStatus?.order?.status ?? s30.orderStatus?.status}  inFrontendOpenOrders=${(s30.frontendOpenOrders as any[]).some(o => o.oid === orphanOid)}`);
      save('33_orphan_o1_after_close_snapshots.json', { orphanOid, ...snaps });

      // Explicit cancel: the response itself tells us whether the stop still existed.
      const c = await doExchange(account, cancelAction([{ a: asset, o: orphanOid }]));
      console.log('  explicit cancel of orphan:', JSON.stringify(c.response));
      save('33_orphan_o1_explicit_cancel.json', { request: c.requestBody, response: c.response, httpStatus: c.httpStatus, meta: c.meta });

      (summary as any).o1 = {
        orphanOid,
        stillInFrontendOpenOrders: {
          after_0s:  (s0.frontendOpenOrders as any[]).some(o => o.oid === orphanOid),
          after_10s: (s10.frontendOpenOrders as any[]).some(o => o.oid === orphanOid),
          after_30s: (s30.frontendOpenOrders as any[]).some(o => o.oid === orphanOid),
        },
        orderStatusAfter: {
          after_0s:  s0.orderStatus?.order?.status ?? s0.orderStatus,
          after_10s: s10.orderStatus?.order?.status ?? s10.orderStatus,
          after_30s: s30.orderStatus?.order?.status ?? s30.orderStatus,
        },
        explicitCancelResponse: c.response,
      };
      await sleep(800);
    }

    // ── O2: pct firing ───────────────────────────────────────────────────────
    console.log('\n📤 O2 setup: reopen long...');
    await openLong('o2_00_open_long');

    // Tight pct ladder (the minimum is unknown); every attempt is saved.
    let oid: number | null = null;
    let usedPct = '';
    const rejected: Array<{ pct: string; response: unknown }> = [];
    for (const pct of ['0.0100%', '0.0500%']) {
      const placed = await placeStop(`o2_pct_${pct.replace('.', 'p').replace('%', 'pct')}`, `O2: CLOSE long, TIGHT pct ${pct}, no activation`,
        trailingStopAction(asset, false, sz, true, { pct }, null));
      oid = placed.oid;
      if (oid !== null) { usedPct = pct; break; }
      rejected.push({ pct, response: placed.r.response });
    }
    (summary as any).o2_rejected = rejected;

    if (!DRY_RUN && oid !== null) {
      const rate = parseFloat(usedPct) / 100;
      const fireStart = Date.now();
      const { ticks, hit } = await watchFast('O2', oid, TRIGGER_TIMEOUT_S, 1000,
        tk => tk.frontend === null || (tk.orderStatus?.order?.status && tk.orderStatus.order.status !== 'open'));
      console.log(hit ? `  🔥 Stop left the book after ${((Date.now() - fireStart) / 1000).toFixed(0)}s` : '  ⚠️  Did not fire within timeout.');

      // triggerPx vs best * (1 - rate) on every tick that still had the order.
      const formulaCheck = ticks.filter(tk => tk.frontend).map(tk => {
        const m = /best ([0-9.]+)/.exec(tk.frontend.triggerCondition ?? '');
        const best = m ? parseFloat(m[1]) : NaN;
        return {
          t: tk.t, triggerCondition: tk.frontend.triggerCondition, best,
          triggerPxReported: parseFloat(tk.frontend.triggerPx),
          triggerPxExpected: best * (1 - rate),
          diff: parseFloat(tk.frontend.triggerPx) - best * (1 - rate),
        };
      });

      await sleep(2500);
      const allFills = await infoPost({ type: 'userFills', user: WALLET_ADDR }) as any[];
      const post = {
        orderStatus:        await infoPost({ type: 'orderStatus', user: WALLET_ADDR, oid }),
        historicalOrders:   await infoPost({ type: 'historicalOrders', user: WALLET_ADDR }),
        userFills:          (Array.isArray(allFills) ? allFills : []).filter(f => f.time >= runStartMs),
        frontendOpenOrders: await infoPost({ type: 'frontendOpenOrders', user: WALLET_ADDR }),
        clearinghouseState: await infoPost({ type: 'clearinghouseState', user: WALLET_ADDR }),
      };
      const lastOpen = [...ticks].reverse().find(tk => tk.frontend !== null);
      const fillsForStop = post.userFills.filter((f: any) => f.oid === oid);
      save('33_orphan_o2_pct_fired.json', {
        fired: hit, retracementPct: usedPct, rate, oid, rejected,
        lastTriggerConditionBeforeFire: lastOpen?.frontend?.triggerCondition ?? null,
        lastFrontendEntryBeforeFire: lastOpen?.frontend ?? null,
        formulaCheck,
        fillWithSameOid: fillsForStop.length > 0,
        fillsForStopOid: fillsForStop,
        post, ticks,
      });
      (summary as any).o2 = {
        oid, retracementPct: usedPct, fired: hit, ticks: ticks.length,
        finalOrderStatus: (post.orderStatus as any)?.order?.status ?? null,
        lastTriggerConditionBeforeFire: lastOpen?.frontend?.triggerCondition ?? null,
        maxAbsFormulaDiff: formulaCheck.length ? Math.max(...formulaCheck.map(f => Math.abs(f.diff))) : null,
        fillWithSameOid: fillsForStop.length > 0,
      };
      if (!hit) {
        const c = await doExchange(account, cancelAction([{ a: asset, o: oid }]));
        save('33_orphan_o2_cancel.json', { request: c.requestBody, response: c.response, httpStatus: c.httpStatus, meta: c.meta });
      }
    }
  } finally {
    // ── Cleanup: cancel leftovers on this coin, close any open position ──────
    if (!DRY_RUN) {
      console.log('\n🧹 Cleanup...');
      try {
        const resting = await getRestingForCoin();
        if (resting.length > 0) {
          const c = await doExchange(account, cancelAction(resting.map(o => ({ a: asset, o: o.oid }))));
          console.log(`  Cancelled ${resting.length} leftover order(s):`, JSON.stringify(c.response));
          save('33_orphan_cleanup_cancel.json', { request: c.requestBody, response: c.response, httpStatus: c.httpStatus });
        }
        const pos = await getPosition();
        if (pos.szi > 0) {
          const m = await getMarket();
          const c = await doExchange(account, orderAction([wire(asset, false, fmtPx(m.markPx * 0.98, szDecimals), fmtSz(pos.szi, szDecimals), true, 'Ioc')]));
          console.log('  Closed position:', JSON.stringify(c.response));
          save('33_orphan_cleanup_close.json', { request: c.requestBody, response: c.response, httpStatus: c.httpStatus });
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
    save('33_orphan_ws_events.json', { count: ws.events.length, events: ws.events });
    summary.finishedAt = new Date().toISOString();
    save('orphan-run-summary.json', summary);
  }

  console.log('\n✅ Done. Captures are in scripts/captures/33_orphan_*.json\n');
}

main().catch(err => {
  console.error('\n❌ Probe failed:', err);
  process.exit(1);
});
