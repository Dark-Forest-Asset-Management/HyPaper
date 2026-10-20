/**
 * probe-hl-testnet-trailing-stop-reduceonly.ts
 *
 * PURPOSE: Round 5 of the trailing-stop probe — settle the reduce-only
 * assumptions the HyPaper plan was guessing at (plan A4, A16, A17, A18):
 *
 *   R1  flat account, SELL reduce-only stop        → accepted or rejected? (A4)
 *   R2  flat account, BUY  reduce-only stop        → accepted or rejected? (A4)
 *   R3  short position + BUY reduce-only stop      → accepted? then close the
 *       short with a normal IOC → is the stop orphan-canceled? (A18)
 *   R4  long 2x + SELL reduce-only stop sized 3x (bigger than the position)
 *       → accepted at placement? (A16 / size handling)
 *   R5  same stop (sz 3x on a 2x long): REDUCE the position by half with a
 *       normal IOC → stop still open? size changed? status? (A16)
 *   R6  then FLIP the position (sell more than the long) → what happens to
 *       the stop? (A17)
 *   WS  orderUpdates + userFills + userEvents across the run.
 *
 * SETUP — .env must have HL_TESTNET_PRIVATE_KEY / HL_TESTNET_WALLET.
 * RUN:    npx tsx scripts/probe-hl-testnet-trailing-stop-reduceonly.ts
 * ENV:    PROBE_COIN, DRY_RUN=1
 * OUTPUT: scripts/captures/34_reduceonly_*.json (+ reduceonly-run-summary.json)
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY!);

  console.log('\n🔬 Hyperliquid Testnet Probe — TRAILING STOP reduce-only edge cases');
  console.log('===================================================================');
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
  const unit = Math.ceil(12 / mkt.markPx / minSz) * minSz;     // ~$12
  const sz1 = fmtSz(unit, szDecimals);
  const sz2 = fmtSz(unit * 2, szDecimals);
  const sz3 = fmtSz(unit * 3, szDecimals);
  console.log(`  ${COIN} asset=${asset} mark=$${mkt.markPx}  sz1=${sz1} sz2=${sz2} sz3=${sz3}\n`);

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
  const summary: Record<string, unknown> = { coin: COIN, asset, sz1, sz2, sz3, startedAt: new Date().toISOString(), dryRun: DRY_RUN };

  // ── helpers ────────────────────────────────────────────────────────────────

  async function ioc(slug: string, isBuy: boolean, size: string, reduceOnly: boolean) {
    const m = DRY_RUN ? mkt : await getMarket();
    const px = fmtPx(m.markPx * (isBuy ? 1.02 : 0.98), szDecimals);
    const r = await doExchange(account, orderAction([wire(asset, isBuy, px, size, reduceOnly, 'Ioc')]));
    save(`34_reduceonly_${slug}.json`, { request: r.requestBody, response: r.response, httpStatus: r.httpStatus, meta: r.meta });
    console.log(`  ${slug}:`, JSON.stringify(r.response));
    await sleep(900);
    return r;
  }

  async function placeStop(slug: string, label: string, isBuy: boolean, size: string, reduceOnly: boolean) {
    console.log(`\n📤 ${label}`);
    const r = await doExchange(account, trailingStopAction(asset, isBuy, size, reduceOnly, { px: '3000' }, null));
    const oid = extractOid(r.response);
    const immediate = DRY_RUN ? null : await infoPost({ type: 'frontendOpenOrders', user: WALLET_ADDR });
    const status = DRY_RUN || oid === null ? null : await infoPost({ type: 'orderStatus', user: WALLET_ADDR, oid });
    console.log(`  HTTP ${r.httpStatus}  ${JSON.stringify(r.response)}`);
    save(`34_reduceonly_${slug}_place.json`, {
      label, request: r.requestBody, response: r.response, httpStatus: r.httpStatus, rawBody: r.rawBody, meta: r.meta,
      immediateFrontendOpenOrders: immediate, immediateOrderStatus: status,
    });
    return { oid, r };
  }

  async function cancelOid(slug: string, oid: number) {
    const c = await doExchange(account, cancelAction([{ a: asset, o: oid }]));
    console.log(`  cancel ${oid}:`, JSON.stringify(c.response));
    save(`34_reduceonly_${slug}_cancel.json`, { request: c.requestBody, response: c.response, httpStatus: c.httpStatus, meta: c.meta });
  }

  async function snapshot(oid: number) {
    const hist = await infoPost({ type: 'historicalOrders', user: WALLET_ADDR }) as any[];
    const pos = await getPosition();
    const fo = await infoPost({ type: 'frontendOpenOrders', user: WALLET_ADDR }) as any[];
    const st = await infoPost({ type: 'orderStatus', user: WALLET_ADDR, oid }) as any;
    return {
      t: new Date().toISOString(),
      positionSzi: pos.szi,
      inFrontendOpenOrders: (Array.isArray(fo) ? fo : []).some(o => o.oid === oid),
      frontendEntry: (Array.isArray(fo) ? fo : []).find(o => o.oid === oid) ?? null,
      orderStatus: st,
      historicalOrdersForOid: (Array.isArray(hist) ? hist : []).filter(h => h?.order?.oid === oid),
    };
  }

  /** snapshots at +1 s, +10 s after an action that may orphan/affect a stop. */
  async function watchAfter(slug: string, oid: number) {
    await sleep(1200);
    const s1 = await snapshot(oid);
    await sleep(9000);
    const s10 = await snapshot(oid);
    save(`34_reduceonly_${slug}_snapshots.json`, { oid, after_1s: s1, after_10s: s10 });
    console.log(`  +1s : szi=${s1.positionSzi} open=${s1.inFrontendOpenOrders} status=${s1.orderStatus?.order?.status ?? s1.orderStatus?.status} sz=${s1.frontendEntry?.sz ?? '-'}`);
    console.log(`  +10s: szi=${s10.positionSzi} open=${s10.inFrontendOpenOrders} status=${s10.orderStatus?.order?.status ?? s10.orderStatus?.status} sz=${s10.frontendEntry?.sz ?? '-'}`);
    return { s1, s10 };
  }

  try {
    // ── R1 / R2: reduce-only stops on a FLAT account ───────────────────────────
    for (const [slug, isBuy] of [['r1_flat_sell', false], ['r2_flat_buy', true]] as const) {
      const { oid } = await placeStop(slug, `${slug.toUpperCase()}: flat account, ${isBuy ? 'BUY' : 'SELL'} reduce-only trailing stop`, isBuy, sz1, true);
      (summary as any)[slug] = { oid, accepted: oid !== null };
      if (!DRY_RUN && oid !== null) {
        const s = await snapshot(oid);
        save(`34_reduceonly_${slug}_snapshot.json`, s as unknown as Record<string, unknown>);
        console.log(`  accepted; status after: ${s.orderStatus?.order?.status}, open=${s.inFrontendOpenOrders}`);
        await cancelOid(slug, oid);
      }
      await sleep(600);
    }

    // ── R3: short position + BUY reduce-only stop (A18), then close the short ──
    console.log('\n📤 R3 setup: open SHORT via IOC sell...');
    await ioc('r3_00_open_short', false, sz1, false);
    const r3 = await placeStop('r3_short_buy_ro', 'R3: short position, BUY reduce-only trailing stop', true, sz1, true);
    (summary as any).r3 = { oid: r3.oid, accepted: r3.oid !== null };
    if (!DRY_RUN && r3.oid !== null) {
      const before = await snapshot(r3.oid);
      save('34_reduceonly_r3_before_close.json', before as unknown as Record<string, unknown>);
      console.log('  closing the short with a normal reduce-only IOC buy...');
      await ioc('r3_01_close_short', true, sz1, true);
      const w = await watchAfter('r3_after_close', r3.oid);
      (summary as any).r3.afterClose = { status1s: w.s1.orderStatus?.order?.status, open1s: w.s1.inFrontendOpenOrders, status10s: w.s10.orderStatus?.order?.status };
    }

    // ── R4/R5/R6: long 2x, SELL reduce-only stop sized 3x ──────────────────────
    console.log('\n📤 R4 setup: open LONG (2x unit)...');
    await ioc('r4_00_open_long2x', true, sz2, false);
    const r4 = await placeStop('r4_oversize_ro', `R4: long ${sz2}, SELL reduce-only trailing stop sized ${sz3} (> position)`, false, sz3, true);
    (summary as any).r4 = { oid: r4.oid, accepted: r4.oid !== null, stopSz: sz3, positionSz: sz2 };

    if (!DRY_RUN && r4.oid !== null) {
      console.log(`\n📤 R5: REDUCE the long by half (sell ${sz1} reduce-only)...`);
      await ioc('r5_00_partial_reduce', false, sz1, true);
      const w5 = await watchAfter('r5_after_partial_reduce', r4.oid);
      (summary as any).r5 = { status1s: w5.s1.orderStatus?.order?.status, open1s: w5.s1.inFrontendOpenOrders, szAfter: w5.s10.frontendEntry?.sz ?? null, status10s: w5.s10.orderStatus?.order?.status };

      // A17: flip. Remaining long = sz2 - sz1 = sz1. Sell 3x (non-reduce-only) → net short ~2x unit.
      console.log(`\n📤 R6: FLIP the position (sell ${sz3} non-reduce-only; long ${sz1} → short)...`);
      await ioc('r6_00_flip', false, sz3, false);
      const w6 = await watchAfter('r6_after_flip', r4.oid);
      (summary as any).r6 = { status1s: w6.s1.orderStatus?.order?.status, open1s: w6.s1.inFrontendOpenOrders, positionAfter: w6.s10.positionSzi, status10s: w6.s10.orderStatus?.order?.status };
    }
  } finally {
    // ── Cleanup: cancel leftovers on this coin, flatten any position ─────────────
    if (!DRY_RUN) {
      console.log('\n🧹 Cleanup...');
      try {
        const resting = await getRestingForCoin();
        if (resting.length > 0) {
          const c = await doExchange(account, cancelAction(resting.map(o => ({ a: asset, o: o.oid }))));
          console.log(`  Cancelled ${resting.length} leftover order(s):`, JSON.stringify(c.response));
          save('34_reduceonly_cleanup_cancel.json', { request: c.requestBody, response: c.response, httpStatus: c.httpStatus });
        }
        const pos = await getPosition();
        if (pos.szi !== 0) {
          const m = await getMarket();
          const isBuy = pos.szi < 0;
          const c = await doExchange(account, orderAction([wire(asset, isBuy, fmtPx(m.markPx * (isBuy ? 1.02 : 0.98), szDecimals), fmtSz(Math.abs(pos.szi), szDecimals), true, 'Ioc')]));
          console.log('  Closed position:', JSON.stringify(c.response));
          save('34_reduceonly_cleanup_close.json', { request: c.requestBody, response: c.response, httpStatus: c.httpStatus });
        } else {
          console.log('  No open position to close.');
        }
        console.log(`  Final ${COIN} szi = ${(await getPosition()).szi}`);
      } catch (err) {
        console.error('  ⚠️  CLEANUP FAILED — check testnet UI manually:', err);
      }
    }
    await sleep(1500);
    ws.close();
    save('34_reduceonly_ws_events.json', { count: ws.events.length, events: ws.events });
    summary.finishedAt = new Date().toISOString();
    save('reduceonly-run-summary.json', summary);
  }

  console.log('\n✅ Done. Captures are in scripts/captures/34_reduceonly_*.json\n');
}

main().catch(err => {
  console.error('\n❌ Probe failed:', err);
  process.exit(1);
});
