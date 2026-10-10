/**
 * probe-hl-testnet-trailing-stop-round6.ts
 *
 * PURPOSE: Round 6 (final) of the trailing-stop probe — close the remaining unknowns that
 * decide how HyPaper must behave (see trailing-stop-summary.md section 12):
 *
 *   T1  oversize reduce-only stop FIRING: stop sized 3x the position — what size fills?
 *   T2  webData2: are trailing stops included, same row shape, and does it follow the ratchet?
 *   T3  buy-side ACTIVATION transition (activation clearly below mark, long wait)
 *   T4  smallest accepted px / pct (+ accepted pct string formats, upper bounds)
 *   T5  flat-account reduce-only stop observed for 5+ minutes — does HL ever cancel it?
 *   T6  non-BTC coins (SOL, ETH): trigger rounding + limitPx rule vs the HyPaper rules; SOL fire
 *   T7  modify / batchModify on a trailing stop oid
 *   T8  fire-time margin failure: an open-long stop far too big for the balance
 *   T9  expiresAfter on a trailingStop (does it expire the ORDER, or only gate the request?)
 *
 * BALANCE-AWARE (testnet wallet holds only a few USDC): everything except T1 and the SOL fire
 * needs no perp margin and runs on the flat account. T1/SOL-fire try to open a ~$12 long; if HL
 * rejects it for margin they are SKIPPED — the script NEVER moves funds between spot and perp.
 *
 * Long-lived stops live on ETH on purpose (T2/T5/T9): the BTC/SOL positions opened by the fire
 * tests would otherwise orphan-cancel them and spoil the observation.
 *
 * SETUP — .env must have HL_TESTNET_PRIVATE_KEY / HL_TESTNET_WALLET.
 * RUN:    npx tsx scripts/probe-hl-testnet-trailing-stop-round6.ts      (takes ~25 minutes)
 * ENV:    R6_FLAT_WATCH_S=330  R6_ACT_WAIT_S=1200  R6_FIRE_TIMEOUT_S=240  R6_FIRE_PX=5
 * OUTPUT: scripts/captures/35_r6_*.json  (+ 35_r6_summary.json)
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

// ─── Round-6 config ───────────────────────────────────────────────────────────

import {
  evaluateTrailing, paramsFromWire, triggerConditionText, fmtPrice1,
  type TrailingParams, type TrailingState,
} from '../src/engine/trailing-math.js';

const FLAT_WATCH_S   = Number(process.env.R6_FLAT_WATCH_S ?? 330);
const ACT_WAIT_S     = Number(process.env.R6_ACT_WAIT_S ?? 1200);
const FIRE_TIMEOUT_S = Number(process.env.R6_FIRE_TIMEOUT_S ?? 240);
const FIRE_PX        = process.env.R6_FIRE_PX ?? '5';
const POLL_TICK_MS   = 10_000;
// R6_ONLY=funded   -> only T8, T8b (zero-margin fire), T1, T6b   (run on a FLAT account with a few USDC)
// R6_ONLY=webdata2 -> only the webData2 debug test
const ONLY = process.env.R6_ONLY ?? '';
if (!['', 'funded', 'webdata2', 'webdata3', 'cleanup'].includes(ONLY)) throw new Error(`unknown R6_ONLY=${ONLY} (use funded | webdata3 | cleanup, or leave unset for the full run)`);
const TAG  = ONLY ? `35_r6_${ONLY}` : '35_r6';

// ─── Market / account helpers (multi-coin) ────────────────────────────────────

const extractOid = (r: any): number | null => r?.response?.data?.oid ?? null;

interface Mkt { coin: string; asset: number; szDecimals: number; maxLeverage: number; mark: number }

async function markets(): Promise<Record<string, Mkt>> {
  const [meta, ctxs] = await infoPost({ type: 'metaAndAssetCtxs' }) as [
    { universe: Array<{ name: string; szDecimals: number; maxLeverage: number }> },
    Array<{ markPx: string }>,
  ];
  const out: Record<string, Mkt> = {};
  for (const coin of ['BTC', 'ETH', 'SOL']) {
    const i = meta.universe.findIndex(u => u.name === coin);
    if (i < 0) continue;
    out[coin] = { coin, asset: i, szDecimals: meta.universe[i].szDecimals, maxLeverage: meta.universe[i].maxLeverage, mark: parseFloat(ctxs[i].markPx) };
  }
  return out;
}
const mk = async (coin: string): Promise<Mkt> => {
  const m = (await markets())[coin];
  if (!m) throw new Error(`${coin} not in testnet universe`);
  return m;
};
/** ~$12 notional, rounded UP to the size step. */
const sizeFor = (m: Mkt, usd = 12) => fmtSz(Math.ceil(usd / m.mark / (1 / 10 ** m.szDecimals)) * (1 / 10 ** m.szDecimals), m.szDecimals);

async function perpState(): Promise<{ accountValue: number; positions: Array<{ coin: string; szi: number }> }> {
  const s = await infoPost({ type: 'clearinghouseState', user: WALLET_ADDR }) as any;
  return {
    accountValue: parseFloat(s?.marginSummary?.accountValue ?? '0'),
    positions: (s?.assetPositions ?? []).map((p: any) => ({ coin: p.position.coin, szi: parseFloat(p.position.szi) })),
  };
}
const spotUsdc = async (): Promise<number> => {
  const s = await infoPost({ type: 'spotClearinghouseState', user: WALLET_ADDR }) as any;
  return parseFloat((s?.balances ?? []).find((b: any) => b.coin === 'USDC')?.total ?? '0');
};
const allResting = async (): Promise<any[]> => {
  const r = await infoPost({ type: 'frontendOpenOrders', user: WALLET_ADDR });
  return Array.isArray(r) ? r : [];
};
const rowOf = async (oid: number) => (await allResting()).find(o => o.oid === oid) ?? null;
const statusOf = async (oid: number): Promise<any> => infoPost({ type: 'orderStatus', user: WALLET_ADDR, oid });
async function historyOf(oid: number): Promise<Array<[string, number]>> {
  const h = await infoPost({ type: 'historicalOrders', user: WALLET_ADDR }) as any[];
  return (Array.isArray(h) ? h : []).filter(x => x?.order?.oid === oid).map(x => [x.status, x.statusTimestamp]);
}

// ─── Exchange (with optional expiresAfter in the signed hash) ────────────────

interface XR {
  requestBody: any; httpStatus: number | null; rawBody: string | null; response: any;
  meta: { nonce: number; msgpackHex: string; connectionId: string; expiresAfter?: number };
}
let lastNonce = 0;

async function xchg(action: unknown, opts?: { expiresAfter?: number }): Promise<XR> {
  const account = privateKeyToAccount(PRIVATE_KEY!);
  const nonce = Math.max(Date.now(), lastNonce + 1);
  lastNonce = nonce;
  // msgpack ‖ nonce(8) ‖ vaultFlag(0) [‖ 0x00 ‖ expiresAfter(8)] — HL's hashing (verified in D3).
  const packed = msgpackEncode(action);
  const extra = opts?.expiresAfter !== undefined ? 9 : 0;
  const buf = new Uint8Array(packed.length + 9 + extra);
  buf.set(packed, 0);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(packed.length, BigInt(nonce), false);
  if (opts?.expiresAfter !== undefined) dv.setBigUint64(packed.length + 10, BigInt(opts.expiresAfter), false);
  const connectionId = keccak256(toHex(buf));
  const sig = await account.signTypedData({
    domain: HL_EIP712_DOMAIN, types: AGENT_TYPES, primaryType: 'Agent',
    message: { source: 'b', connectionId },
  });
  const signature = { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: parseInt(sig.slice(130, 132), 16) };
  const body: any = { action, nonce, signature };
  if (opts?.expiresAfter !== undefined) body.expiresAfter = opts.expiresAfter;
  const res = await fetch(EXCHANGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { nonJson: text.slice(0, 500) }; }
  return {
    requestBody: body, httpStatus: res.status, rawBody: text, response: parsed,
    meta: { nonce, msgpackHex: toHex(msgpackEncode(action)), connectionId, expiresAfter: opts?.expiresAfter },
  };
}

// ─── Capture bookkeeping ──────────────────────────────────────────────────────

const S: Record<string, any> = { startedAt: new Date().toISOString() };
const note = (k: string, v: unknown) => { S[k] = v; };
const saveR = (name: string, data: Record<string, unknown>) => save(`${TAG}_${name}.json`, data);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const stopWire = (m: Mkt, isBuy: boolean, sz: string, reduceOnly: boolean, retracement: Retracement, act: string | null) =>
  trailingStopAction(m.asset, isBuy, sz, reduceOnly, retracement, act);

async function placeStop(
  slug: string, label: string, action: ReturnType<typeof trailingStopAction>, opts?: { expiresAfter?: number },
) {
  console.log(`\n📤 ${label}`);
  const r = await xchg(action, opts);
  const oid = extractOid(r.response);
  const row = oid !== null ? await rowOf(oid) : null;
  const st = oid !== null ? await statusOf(oid) : null;
  console.log(`  HTTP ${r.httpStatus}  ${JSON.stringify(r.response)}`);
  saveR(`${slug}_place`, { label, request: r.requestBody, response: r.response, httpStatus: r.httpStatus, meta: r.meta, immediateRow: row, immediateOrderStatus: st });
  return { oid, r, row };
}
async function cancelOid(slug: string, m: Mkt, oid: number) {
  const c = await xchg(cancelAction([{ a: m.asset, o: oid }]));
  saveR(`${slug}_cancel`, { request: c.requestBody, response: c.response, httpStatus: c.httpStatus });
  return c;
}
async function ioc(slug: string, m: Mkt, isBuy: boolean, size: string, reduceOnly: boolean) {
  const cur = await mk(m.coin);
  const r = await xchg(orderAction([wire(m.asset, isBuy, fmtPx(cur.mark * (isBuy ? 1.02 : 0.98), m.szDecimals), size, reduceOnly, 'Ioc')]));
  saveR(slug, { request: r.requestBody, response: r.response, httpStatus: r.httpStatus });
  const st = r.response?.response?.data?.statuses?.[0];
  console.log(`  ${slug}: ${JSON.stringify(st ?? r.response)}`);
  await sleep(900);
  return { r, filled: !!st?.filled, error: st?.error ?? (r.response?.status === 'err' ? r.response.response : null) };
}

// ─── Background poller + websocket (webData2 included) ───────────────────────

interface Sample { t: string; mark: number | null; row: any | null; status: string | null }
const tracked = new Map<string, { oid: number; coin: string; samples: Sample[] }>();
const track = (key: string, oid: number, coin: string) => tracked.set(key, { oid, coin, samples: [] });
let pollTimer: NodeJS.Timeout | null = null;
let polling = false;

function startPoller() {
  pollTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const rows = await allResting();
      const mk6 = await markets();
      for (const t of tracked.values()) {
        const st = await statusOf(t.oid);
        t.samples.push({ t: new Date().toISOString(), mark: mk6[t.coin]?.mark ?? null, row: rows.find(o => o.oid === t.oid) ?? null, status: st?.order?.status ?? st?.status ?? null });
      }
    } catch (e) { console.log(`  (poller: ${errMsg(e)})`); } finally { polling = false; }
  }, POLL_TICK_MS);
}

interface WsFrame { t: string; msg: any }
const wsFrames: WsFrame[] = [];
/** Non-user-data channels (subscriptionResponse / error / webData2 samples) - for debugging subscriptions. */
const wsRaw: Array<{ t: string; raw: string }> = [];
const wsChannelCounts: Record<string, number> = {};
const web2: Array<{ t: string; serverTime: unknown; n: number; ours: any[] }> = [];
let web2Keys: string[] = [];
let wsRef: WebSocket | null = null;

function startWs(): Promise<void> {
  const ws = new WebSocket(WS_URL);
  wsRef = ws;
  const ready = new Promise<void>(res => {
    ws.on('open', () => {
      for (const type of ['orderUpdates', 'userFills', 'userEvents', 'webData2']) {
        ws.send(JSON.stringify({ method: 'subscribe', subscription: { type, user: WALLET_ADDR } }));
      }
      res();
    });
    ws.on('error', () => res());
  });
  ws.on('message', (d: WebSocket.RawData) => {
    let m: any;
    try { m = JSON.parse(d.toString()); } catch { return; }
    wsChannelCounts[m.channel] = (wsChannelCounts[m.channel] ?? 0) + 1;
    if (!['orderUpdates', 'userFills', 'user', 'pong'].includes(m.channel) && (wsRaw.length < 60 || m.channel !== 'webData2')) {
      wsRaw.push({ t: new Date().toISOString(), raw: d.toString().slice(0, 600) });
    }
    if (m.channel === 'webData3') {
      if (wsFull.length < 2) wsFull.push(m);
      const oids = new Set([...tracked.values()].map(t => t.oid));
      const ours: any[] = [];
      findOrders(m.data, oids, ours);
      web3.push({ t: new Date().toISOString(), serverTime: m.data?.userState?.serverTime, ours });
    }
    if (m.channel === 'webData2') {
      const data = m.data ?? {};
      if (!web2Keys.length) web2Keys = Object.keys(data);
      const oids = new Set([...tracked.values()].map(t => t.oid));
      const oo: any[] = Array.isArray(data.openOrders) ? data.openOrders : [];
      web2.push({ t: new Date().toISOString(), serverTime: data.serverTime, n: oo.length, ours: oo.filter(o => oids.has(o.oid)) });
    } else if (['orderUpdates', 'userFills', 'user'].includes(m.channel)) {
      wsFrames.push({ t: new Date().toISOString(), msg: m });
    }
  });
  setInterval(() => { try { ws.send(JSON.stringify({ method: 'ping' })); } catch { /* closed */ } }, 30_000).unref();
  return ready;
}
/** webData3 (the testnet rejects webData2): frames that mention our tracked stops, found by a deep search for their oids. */
const web3: Array<{ t: string; serverTime: unknown; ours: any[] }> = [];
const wsFull: any[] = [];
function findOrders(node: any, oids: Set<number>, out: any[]) {
  if (Array.isArray(node)) { for (const x of node) findOrders(x, oids, out); return; }
  if (node && typeof node === 'object') {
    if (typeof node.oid === 'number' && oids.has(node.oid)) out.push(node);
    for (const v of Object.values(node)) findOrders(v, oids, out);
  }
}
const wsSend = (o: unknown) => { try { wsRef?.send(JSON.stringify(o)); } catch { /* closed */ } };

// ─── Helpers for the fire tests ──────────────────────────────────────────────

async function watchStop(oid: number, timeoutS: number, label: string) {
  const t0 = Date.now();
  const ticks: Array<{ t: string; row: any | null; status: string | null }> = [];
  let lastRow: any = null;
  while ((Date.now() - t0) / 1000 < timeoutS) {
    const row = await rowOf(oid);
    const st = await statusOf(oid);
    const status = st?.order?.status ?? st?.status ?? null;
    if (row) lastRow = row;
    ticks.push({ t: new Date().toISOString(), row, status });
    if ((ticks.length % 5) === 1) console.log(`  [${label}] ${row?.triggerCondition ?? '(not resting)'}  trig=${row?.triggerPx ?? '-'}  status=${status}`);
    if (!row || (status && status !== 'open')) return { fired: true, ticks, lastRow, seconds: (Date.now() - t0) / 1000 };
    await sleep(2000);
  }
  return { fired: false, ticks, lastRow, seconds: (Date.now() - t0) / 1000 };
}

function parseProse(text: string) {
  const m = /^Activation (immediate|above|below)(?: ([0-9.]+))?, retracement ([0-9.]+)(%?), best (waiting|[0-9.]+)$/.exec(text ?? '');
  if (!m) return null;
  return { activationPx: m[2] ?? null, kind: m[4] === '%' ? 'pct' as const : 'px' as const, value: m[3], best: m[5] === 'waiting' ? null : m[5] };
}

/** Compare one captured HL row with HyPaper's rules (src/engine/trailing-math). */
function ruleCheck(row: any, m: Mkt) {
  const p = parseProse(row?.triggerCondition);
  if (!p) return { ok: false, why: `unparseable: ${row?.triggerCondition}` };
  const params: TrailingParams = { isBuy: row.side === 'B', kind: p.kind, value: p.value, activationPx: p.activationPx, szDecimals: m.szDecimals };
  const state: TrailingState = { activated: p.best !== null, best: p.best };
  const ev = evaluateTrailing(params, state, p.best !== null ? p.best : String(params.isBuy ? Number(p.activationPx) * 10 : Number(p.activationPx) / 10));
  const predTrig = ev.triggerPx === null ? '0.0' : fmtPrice1(ev.triggerPx);
  const predLimit = fmtPrice1(ev.limitPx);
  const text = triggerConditionText(params, ev.state);
  return {
    ok: predTrig === row.triggerPx && predLimit === row.limitPx && text === row.triggerCondition,
    triggerPx: { hl: row.triggerPx, hyPaper: predTrig }, limitPx: { hl: row.limitPx, hyPaper: predLimit },
    text: { hl: row.triggerCondition, hyPaper: text },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

/** T4 — smallest accepted px / pct, accepted pct formats, upper bounds. Flat account, nothing rests. */
async function t4() {
  console.log('\n══ T4: smallest accepted px / pct ══');
  const m = await mk('BTC');
  const sz = sizeFor(m);
  const attempts: any[] = [];
  const tryOne = async (kind: string, value: string) => {
    const r = await xchg(stopWire(m, false, sz, true, kind === 'px' ? { px: value } : { pct: value }, null));
    const oid = extractOid(r.response);
    let text: string | null = null;
    if (oid !== null) { text = (await rowOf(oid))?.triggerCondition ?? null; await cancelOid(`t4_${kind}_${value.replace(/[^0-9a-z]/gi, '_')}`, m, oid); }
    attempts.push({ kind, value, accepted: oid !== null, response: r.response, httpStatus: r.httpStatus, text });
    console.log(`  ${kind} ${value.padEnd(12)} → ${oid !== null ? `accepted  "${text}"` : JSON.stringify(r.response)}`);
    await sleep(350);
  };
  for (const v of ['1', '0.5', '0.1', '0.05', '0.01', '0.001', '0.0001', '0.00001', '0.000001']) await tryOne('px', v);
  for (const v of ['1.0000%', '0.1000%', '0.0100%', '0.0010%', '0.0001%', '0.00001%', '0.000001%']) await tryOne('pct', v);
  // accepted string formats for pct (UI sent "5.0000%")
  for (const v of ['5%', '5.0%', '5.00000%', '05.0000%', '5', '5.0000', '%5', ' 5.0000%']) await tryOne('pct', v);
  // upper bounds
  for (const v of ['99.9999%', '100.0000%', '150.0000%']) await tryOne('pct', v);
  for (const v of ['100000', '1000000', '99999999']) await tryOne('px', v);
  const minPx = attempts.filter(a => a.kind === 'px' && a.accepted && /^[0-9.]+$/.test(a.value) && Number(a.value) < 1).map(a => Number(a.value));
  const minPct = attempts.filter(a => a.kind === 'pct' && a.accepted && /^[0-9.]+0*%$/.test(a.value)).map(a => Number(a.value.replace('%', '')));
  note('t4', {
    smallestPxAccepted: minPx.length ? Math.min(...minPx) : null,
    smallestPctAccepted: minPct.length ? Math.min(...minPct) : null,
    rejected: attempts.filter(a => !a.accepted).map(a => ({ kind: a.kind, value: a.value, response: a.response?.response ?? a.response })),
    acceptedFormats: attempts.filter(a => a.accepted && a.kind === 'pct').map(a => ({ value: a.value, text: a.text })),
  });
  saveR('t4_min_values', { attempts });
}

/** T7 — modify / batchModify on a trailing stop oid. */
async function t7() {
  console.log('\n══ T7: modify / batchModify on a trailing stop ══');
  const m = await mk('BTC');
  const sz = sizeFor(m);
  const { oid } = await placeStop('t7_target', 'T7: flat-account BTC sell reduce-only stop (modify target)', stopWire(m, false, sz, true, { px: '3000' }, null));
  if (oid === null) { note('t7', { skipped: 'stop not placed' }); return; }
  const wires = [
    ['A_nonRO_buy_limit', wire(m.asset, true, fmtPx(m.mark * 0.9, m.szDecimals), sz, false, 'Gtc')],
    ['B_RO_sell_limit', wire(m.asset, false, fmtPx(m.mark * 1.1, m.szDecimals), sz, true, 'Gtc')],
  ] as const;
  const out: any[] = [];
  for (const [name, w] of wires) {
    const r1 = await xchg({ type: 'modify', oid, order: w });
    const stAfter = await statusOf(oid);
    const rowAfter = await rowOf(oid);
    out.push({ kind: 'modify', wire: name, response: r1.response, stopStatusAfter: stAfter?.order?.status ?? stAfter?.status, stopStillTrailing: rowAfter?.orderType ?? null });
    console.log(`  modify[${name}] → ${JSON.stringify(r1.response)}   stop: ${stAfter?.order?.status} / ${rowAfter?.orderType ?? '(gone)'}`);
    if (!rowAfter) break; // consumed/replaced
    await sleep(500);
  }
  const live = await rowOf(oid);
  if (live) {
    const w = wires[0][1];
    const r2 = await xchg({ type: 'batchModify', modifies: [{ oid, order: w }] });
    out.push({ kind: 'batchModify', wire: wires[0][0], response: r2.response, stopStillTrailing: (await rowOf(oid))?.orderType ?? null });
    console.log(`  batchModify → ${JSON.stringify(r2.response)}`);
  }
  note('t7', out);
  saveR('t7_modify', { oid, results: out });
  // clean whatever is left of this experiment (stop and/or any order modify created)
  // clean ONLY what this experiment created — never the long-lived tracked stops (T3 lives on BTC).
  const keep = new Set([...tracked.values()].map(t => t.oid));
  for (const o of (await allResting()).filter(o => o.coin === 'BTC' && !keep.has(o.oid))) await cancelOid(`t7_clean_${o.oid}`, m, o.oid);
}

/** T6a — rounding / limitPx rule on SOL + ETH (placed flat, cancelled at once). */
async function t6a() {
  console.log('\n══ T6a: non-BTC rounding + limitPx rule (SOL, ETH) ══');
  const rows: any[] = [];
  const all = await markets();
  for (const coin of ['SOL', 'ETH']) {
    const m = all[coin];
    if (!m) continue;
    const sz = sizeFor(m);
    const actUp = fmtPx(m.mark * 1.002, m.szDecimals);
    const actDn = fmtPx(m.mark * 0.998, m.szDecimals);
    const variants: Array<[string, boolean, Retracement, string | null]> = [
      ['sell px 0.05', false, { px: '0.05' }, null], ['sell px 0.123', false, { px: '0.123' }, null],
      ['sell px 1.5', false, { px: '1.5' }, null], ['sell pct 0.5%', false, { pct: '0.5000%' }, null],
      ['sell pct 1.2345%', false, { pct: '1.2345%' }, null], ['sell px 0.5 act above', false, { px: '0.5' }, actUp],
      ['buy px 0.05', true, { px: '0.05' }, null], ['buy px 0.123', true, { px: '0.123' }, null],
      ['buy pct 0.5%', true, { pct: '0.5000%' }, null], ['buy pct 1.2345%', true, { pct: '1.2345%' }, null],
      ['buy px 0.5 act below', true, { px: '0.5' }, actDn],
    ];
    for (const [name, isBuy, ret, act] of variants) {
      const r = await xchg(stopWire(m, isBuy, sz, true, ret, act));
      const oid = extractOid(r.response);
      if (oid === null) { rows.push({ coin, name, error: r.response }); console.log(`  ${coin} ${name} → ${JSON.stringify(r.response)}`); continue; }
      const row = await rowOf(oid);
      const chk = ruleCheck(row, m);
      rows.push({ coin, name, szDecimals: m.szDecimals, mark: m.mark, row, ruleCheck: chk });
      console.log(`  ${coin} ${name.padEnd(22)} trig ${row?.triggerPx} limit ${row?.limitPx}  ${chk.ok ? '✓ matches HyPaper rules' : '✗ MISMATCH'}`);
      await cancelOid(`t6a_${coin}_${oid}`, m, oid);
      await sleep(300);
    }
  }
  const bad = rows.filter(r => r.ruleCheck && !r.ruleCheck.ok);
  note('t6a', { rows: rows.length, mismatches: bad.length, mismatchDetail: bad.map(b => ({ coin: b.coin, name: b.name, ...b.ruleCheck })) });
  saveR('t6a_rounding', { rows });
}

/** T8 — fire-time margin failure: open-long stop far too big for the balance. */
async function t8() {
  console.log('\n══ T8: fire-time margin failure ══');
  const m = await mk('BTC');
  const bal = Math.max(await spotUsdc(), (await perpState()).accountValue, 1);
  // margin needed at MAX leverage ≈ 3x the whole balance → can never be afforded
  const notional = bal * m.maxLeverage * 3;
  const sz = fmtSz(Math.ceil(notional / m.mark / 1e-5) * 1e-5, m.szDecimals);
  console.log(`  balance ≈ $${bal.toFixed(2)}, maxLev ${m.maxLeverage}x → stop notional ≈ $${(parseFloat(sz) * m.mark).toFixed(0)} (sz ${sz})`);
  const { oid, r } = await placeStop('t8_bigstop', 'T8: BUY (open long) stop, px ' + FIRE_PX + ', size far beyond margin', stopWire(m, true, sz, false, { px: FIRE_PX }, null));
  if (oid === null) { note('t8', { placementRejected: true, response: r.response }); return; }
  const w = await watchStop(oid, FIRE_TIMEOUT_S, 'T8');
  const st = await statusOf(oid);
  const fills = (await infoPost({ type: 'userFills', user: WALLET_ADDR }) as any[]).filter((f: any) => f.oid === oid);
  const hist = await historyOf(oid);
  const pos = await perpState();
  note('t8', {
    placementAccepted: true, resolved: w.fired, seconds: w.seconds, finalStatus: st?.order?.status ?? st?.status,
    finalBody: st?.order?.order, history: hist, fills, positions: pos.positions,
  });
  saveR('t8_margin_failure', { oid, watch: { fired: w.fired, seconds: w.seconds, lastRow: w.lastRow }, orderStatus: st, history: hist, fills, positions: pos.positions });
  console.log(`  → fired=${w.fired}  status=${st?.order?.status ?? st?.status}  fills=${fills.length}  history=${JSON.stringify(hist.map(h => h[0]))}`);
  if (!w.fired) await cancelOid('t8_cancel', m, oid);
}

/** Try to open a ~$12 long. Returns the filled size, or the rejection text (never moves funds). */
async function tryOpenLong(slug: string, m: Mkt, sz: string) {
  const r = await ioc(slug, m, true, sz, false);
  return r;
}

/** T1 — oversize reduce-only stop firing (needs a funded position). */
async function t1() {
  console.log('\n══ T1: oversize reduce-only stop firing ══');
  const m = await mk('BTC');
  const sz1 = sizeFor(m);
  const open = await tryOpenLong('t1_00_open_long', m, sz1);
  if (!open.filled) { note('t1', { skipped: 'could not open the position (no perp margin)', reason: open.error }); console.log(`  SKIPPED — ${open.error}`); return false; }
  const sz3 = fmtSz(parseFloat(sz1) * 3, m.szDecimals);
  const { oid } = await placeStop('t1_oversize', `T1: long ${sz1}, SELL reduce-only stop sized ${sz3} (3x), px ${FIRE_PX}`, stopWire(m, false, sz3, true, { px: FIRE_PX }, null));
  if (oid === null) { note('t1', { skipped: 'stop rejected' }); return true; }
  const w = await watchStop(oid, FIRE_TIMEOUT_S, 'T1');
  await sleep(2500);
  const st = await statusOf(oid);
  const fills = (await infoPost({ type: 'userFills', user: WALLET_ADDR }) as any[]).filter((f: any) => f.oid === oid);
  const hist = await historyOf(oid);
  const pos = await perpState();
  note('t1', {
    positionSz: sz1, stopSz: sz3, fired: w.fired, seconds: w.seconds,
    fillSizes: fills.map((f: any) => f.sz), finalStatus: st?.order?.status ?? st?.status, finalBody: st?.order?.order,
    history: hist.map(h => h[0]), positionAfter: pos.positions.filter(p => p.coin === 'BTC'),
  });
  saveR('t1_oversize_fire', { oid, watch: { fired: w.fired, seconds: w.seconds, lastRow: w.lastRow }, orderStatus: st, fills, history: hist, positions: pos.positions });
  console.log(`  → fired=${w.fired}  fill sizes=${JSON.stringify(fills.map((f: any) => f.sz))}  status=${st?.order?.status}  body.sz=${st?.order?.order?.sz}`);
  if (!w.fired) await cancelOid('t1_cancel', m, oid);
  return true;
}

/** T6b — SOL full cycle: fire a tight stop and check the limitPx rule at fire. */
async function t6b() {
  console.log('\n══ T6b: SOL fire ══');
  const m = await mk('SOL');
  const sz = sizeFor(m);
  const open = await tryOpenLong('t6b_00_open_long', m, sz);
  if (!open.filled) { note('t6b', { skipped: 'could not open the position (no perp margin)', reason: open.error }); console.log(`  SKIPPED — ${open.error}`); return; }
  const { oid, row } = await placeStop('t6b_sol_stop', `T6b: SOL long ${sz}, SELL reduce-only stop px 0.05`, stopWire(m, false, sz, true, { px: '0.05' }, null));
  if (oid === null) { note('t6b', { skipped: 'stop rejected' }); return; }
  const w = await watchStop(oid, FIRE_TIMEOUT_S, 'T6b');
  await sleep(2500);
  const st = await statusOf(oid);
  const fills = (await infoPost({ type: 'userFills', user: WALLET_ADDR }) as any[]).filter((f: any) => f.oid === oid);
  const hist = await historyOf(oid);
  note('t6b', {
    fired: w.fired, seconds: w.seconds, placementRow: row, ruleCheckAtPlacement: row ? ruleCheck(row, m) : null,
    lastRowBeforeFire: w.lastRow, ruleCheckBeforeFire: w.lastRow ? ruleCheck(w.lastRow, m) : null,
    fills, finalStatus: st?.order?.status, history: hist.map(h => h[0]),
  });
  saveR('t6b_sol_fire', { oid, watch: { fired: w.fired, seconds: w.seconds, lastRow: w.lastRow }, orderStatus: st, fills, history: hist });
  if (!w.fired) await cancelOid('t6b_cancel', m, oid);
  const pos = (await perpState()).positions.find(p => p.coin === 'SOL');
  if (pos && pos.szi !== 0) await ioc('t6b_99_close', m, pos.szi < 0, fmtSz(Math.abs(pos.szi), m.szDecimals), true);
}

/** Flatten every open position (reduce-only IOC). */
async function closeAll() {
  const all = await markets();
  for (const p of (await perpState()).positions) {
    const m = all[p.coin];
    if (m && p.szi !== 0) await ioc(`close_${p.coin}`, m, p.szi < 0, fmtSz(Math.abs(p.szi), m.szDecimals), true);
  }
}

/** T8b - fire-time margin when NO free margin is left (a position already consumed it). */
async function t8b() {
  console.log('\n== T8b: stop fires with ZERO free margin ==');
  const m = await mk('BTC');
  const pos = (await perpState()).positions.find(p => p.coin === 'BTC');
  console.log(`  existing BTC position: ${pos?.szi ?? 0}`);
  const bal = Math.max(await spotUsdc(), 1);
  const sz = fmtSz(Math.ceil((bal * m.maxLeverage * 3) / m.mark / 1e-5) * 1e-5, m.szDecimals);
  const { oid, r } = await placeStop('t8b_zero_margin', 'T8b: BUY stop px ' + FIRE_PX + ', no free margin left', stopWire(m, true, sz, false, { px: FIRE_PX }, null));
  if (oid === null) { note('t8b', { placementRejected: true, response: r.response }); return; }
  const w = await watchStop(oid, FIRE_TIMEOUT_S, 'T8b');
  await sleep(2500);
  const st = await statusOf(oid);
  const fills = (await infoPost({ type: 'userFills', user: WALLET_ADDR }) as any[]).filter((f: any) => f.oid === oid);
  const hist = await historyOf(oid);
  note('t8b', {
    positionBefore: pos?.szi ?? 0, resolved: w.fired, seconds: w.seconds, finalStatus: st?.order?.status ?? st?.status,
    finalBody: st?.order?.order, history: hist.map(h => h[0]), fills,
  });
  saveR('t8b_zero_margin', { oid, watch: { fired: w.fired, seconds: w.seconds, lastRow: w.lastRow }, orderStatus: st, fills, history: hist });
  console.log(`  -> resolved=${w.fired} status=${st?.order?.status ?? st?.status} fills=${fills.length} history=${JSON.stringify(hist.map(h => h[0]))}`);
  if (!w.fired) await cancelOid('t8b_cancel', m, oid);
}

/** webData2 debug: log EVERY channel, retry the subscription, and compare with frontendOpenOrders. */
async function webdata2Test() {
  console.log('\n== T2: webData2 ==');
  const eth = await mk('ETH');
  const sz = sizeFor(eth);
  const a = await placeStop('w2_sell', 'T2: ETH flat sell reduce-only stop', stopWire(eth, false, sz, true, { px: '30' }, null));
  const b = await placeStop('w2_buy', 'T2: ETH flat buy reduce-only stop', stopWire(eth, true, sz, true, { px: '30' }, null));
  if (a.oid !== null) track('w2sell', a.oid, 'ETH');
  if (b.oid !== null) track('w2buy', b.oid, 'ETH');
  // re-subscribe AFTER the stops exist (a fresh subscription pushes a snapshot), plus the newer webData3 name
  wsSend({ method: 'subscribe', subscription: { type: 'webData2', user: WALLET_ADDR } });
  wsSend({ method: 'subscribe', subscription: { type: 'webData3', user: WALLET_ADDR } });
  for (let i = 0; i < 15; i++) { await sleep(10_000); console.log(`  ... ${(i + 1) * 10}s  channels=${JSON.stringify(wsChannelCounts)}`); }
  const keysOf = (o: any) => (o && typeof o === 'object' ? Object.keys(o) : null);
  const f0 = wsFull[0]?.data;
  const t3a: any = { channelCounts: wsChannelCounts, frames: web3.length, topKeys: keysOf(f0), userStateKeys: keysOf(f0?.userState), perOid: {} };
  if (Array.isArray(f0?.perpDexStates)) t3a.perpDexStateKeys = keysOf(f0.perpDexStates[0]);
  for (const k of ['w2sell', 'w2buy']) {
    const t = tracked.get(k);
    if (!t) continue;
    const inWeb = web3.filter(f => f.ours.some(o => o.oid === t.oid));
    const rowsIn = inWeb.map(f => f.ours.find(o => o.oid === t.oid));
    const webTexts = [...new Set(rowsIn.map(r => r.triggerCondition))];
    const pollTexts = [...new Set(t.samples.map(s => s.row?.triggerCondition).filter(Boolean))];
    const frontRow = [...t.samples].reverse().find(s => s.row)?.row ?? null;
    t3a.perOid[k] = {
      oid: t.oid, framesContainingIt: inWeb.length, distinctTextsInWebData3: webTexts, distinctTextsInPolls: pollTexts,
      followsRatchet: pollTexts.length > 1 ? webTexts.length > 1 : 'n/a (mark did not move)',
      rowKeysEqualFrontendRow: rowsIn.length && frontRow ? JSON.stringify(Object.keys(rowsIn[rowsIn.length - 1])) === JSON.stringify(Object.keys(frontRow)) : null,
      webData3Row: rowsIn.at(-1) ?? null, frontendRow: frontRow,
    };
  }
  note('t2_webdata3', t3a);
  saveR('webdata3_full_frames', { first: wsFull, samples: web3.slice(0, 120) });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY!);
  console.log('\n🔬 Hyperliquid Testnet Probe — TRAILING STOP round 6');
  console.log('=====================================================');
  console.log(`Wallet : ${account.address}`);
  if (account.address.toLowerCase() !== WALLET_ADDR!.toLowerCase()) { console.error('❌ key mismatch'); process.exit(1); }

  const ps = await perpState();
  const spot = await spotUsdc();
  const resting = await allResting();
  console.log(`perp accountValue=$${ps.accountValue}  spot USDC=$${spot}  positions=${JSON.stringify(ps.positions)}  resting=${resting.length}`);
  note('balances', { perpAccountValue: ps.accountValue, spotUsdc: spot });
  if (ONLY !== 'cleanup' && (ps.positions.length > 0 || resting.length > 0)) {
    console.error('❌ Wallet already has positions / resting orders — clear them first so cleanup cannot touch unrelated state.');
    process.exit(1);
  }
  const all = await markets();
  for (const c of ['BTC', 'ETH', 'SOL']) if (!all[c]) throw new Error(`${c} missing on testnet`);
  console.log(`marks: ${Object.values(all).map(m => `${m.coin} ${m.mark}`).join('  ')}`);

  await startWs();
  startPoller();
  const t0 = Date.now();

  try {
    if (ONLY === 'funded') {
      await t8().catch(e => { console.log(`  T8 error: ${errMsg(e)}`); note('t8_error', errMsg(e)); });
      await t8b().catch(e => { console.log(`  T8b error: ${errMsg(e)}`); note('t8b_error', errMsg(e)); });
      await closeAll();
      const ok = await t1().catch(e => { console.log(`  T1 error: ${errMsg(e)}`); note('t1_error', errMsg(e)); return false; });
      if (ok) await t6b().catch(e => { console.log(`  T6b error: ${errMsg(e)}`); note('t6b_error', errMsg(e)); });
    } else if (ONLY === 'webdata2' || ONLY === 'webdata3') {
      await webdata2Test();
    } else if (ONLY === 'cleanup') {
      console.log('  cleanup mode: nothing to run, the finally-block cancels leftovers and flattens');
    } else {
    const eth = all.ETH;
    const ethSz = sizeFor(eth);

    // ── long-lived observations on ETH (T5 / T2 / T9 / T3) ─────────────────────────
    const flatSell = await placeStop('t5_flat_sell', 'T5/T2: FLAT account ETH SELL reduce-only stop (long-lived)', stopWire(eth, false, ethSz, true, { px: '30' }, null));
    const flatBuy = await placeStop('t5_flat_buy', 'T5/T2: FLAT account ETH BUY reduce-only stop (long-lived)', stopWire(eth, true, ethSz, true, { px: '30' }, null));
    const flatPlacedAt = Date.now();
    if (flatSell.oid !== null) track('flatSell', flatSell.oid, 'ETH');
    if (flatBuy.oid !== null) track('flatBuy', flatBuy.oid, 'ETH');

    // T9: expiresAfter on a trailingStop — (a) 90 s ahead, observe whether the ORDER disappears; (b) already in the past
    const expAt = Date.now() + 90_000;
    const t9a = await placeStop('t9_expiry_future', 'T9a: ETH flat sell stop with expiresAfter = now+90s', stopWire(eth, false, ethSz, true, { px: '30' }, null), { expiresAfter: expAt });
    if (t9a.oid !== null) track('t9a', t9a.oid, 'ETH');
    const t9b = await placeStop('t9_expiry_past', 'T9b: ETH flat sell stop with expiresAfter in the PAST', stopWire(eth, false, ethSz, true, { px: '30' }, null), { expiresAfter: Date.now() - 10_000 });
    note('t9', { futureAccepted: t9a.oid !== null, futureResponse: t9a.r.response, expiresAfter: expAt, pastResponse: t9b.r.response, pastAccepted: t9b.oid !== null });
    if (t9b.oid !== null) { await cancelOid('t9b', eth, t9b.oid); }

    // T3: BUY (open-long) stop with activation clearly BELOW mark, wide retracement so it cannot fire
    const btc = await mk('BTC');
    const actPx = fmtPx(btc.mark * 0.9988, btc.szDecimals);          // ≈ 0.12 % below
    const t3 = await placeStop('t3_buy_activation', `T3: BTC BUY stop, activation ${actPx} (~0.12% below mark ${btc.mark}), px 3000`,
      stopWire(btc, true, sizeFor(btc), false, { px: '3000' }, actPx));
    const t3PlacedAt = Date.now();
    if (t3.oid !== null) track('t3', t3.oid, 'BTC');
    note('t3_start', { placementAccepted: t3.oid !== null, response: t3.r.response, activationPx: actPx, markAtPlacement: btc.mark, immediateText: t3.row?.triggerCondition });

    // ── short foreground tests ──────────────────────────────────────────────────────
    await t4().catch(e => { console.log(`  T4 error: ${errMsg(e)}`); note('t4_error', errMsg(e)); });
    await t7().catch(e => { console.log(`  T7 error: ${errMsg(e)}`); note('t7_error', errMsg(e)); });
    await t6a().catch(e => { console.log(`  T6a error: ${errMsg(e)}`); note('t6a_error', errMsg(e)); });
    await t8().catch(e => { console.log(`  T8 error: ${errMsg(e)}`); note('t8_error', errMsg(e)); });

    // ── funded tests (skipped, never funded by this script, when perp margin is missing) ──
    const funded = await t1().catch(e => { console.log(`  T1 error: ${errMsg(e)}`); note('t1_error', errMsg(e)); return false; });
    if (funded) await t6b().catch(e => { console.log(`  T6b error: ${errMsg(e)}`); note('t6b_error', errMsg(e)); });
    else note('t6b', { skipped: 'T1 could not open a position — no perp margin' });

    // ── wait until every long observation has had its time ───────────────────────────
    console.log(`\n⏱  waiting: flat ≥${FLAT_WATCH_S}s, T9 expiry window, T3 activation (≤${ACT_WAIT_S}s)…`);
    for (;;) {
      const flatDone = (Date.now() - flatPlacedAt) / 1000 >= FLAT_WATCH_S;
      const expDone = Date.now() > expAt + 60_000;
      const t3s = tracked.get('t3');
      const lastT3 = t3s?.samples.at(-1);
      const t3Activated = !!lastT3?.row && /best [0-9]/.test(lastT3.row.triggerCondition ?? '');
      const t3Gone = !!t3s && t3s.samples.length > 0 && !lastT3?.row;
      const t3Done = t3.oid === null || t3Activated || t3Gone || (Date.now() - t3PlacedAt) / 1000 >= ACT_WAIT_S;
      if (flatDone && expDone && t3Done) break;
      if (Math.round((Date.now() - t0) / 1000) % 60 < 6) console.log(`  … ${Math.round((Date.now() - t0) / 1000)}s  flat=${flatDone} expiry=${expDone} t3=${t3Done}${lastT3?.row ? ` (${lastT3.row.triggerCondition})` : ''}`);
      await sleep(5000);
    }
    await sleep(POLL_TICK_MS + 2000); // one more poll sample after the last condition
    }
  } finally {
    if (pollTimer) clearInterval(pollTimer);
    console.log('\n🧹 Cleanup...');
    try {
      const all2 = await markets();
      for (const o of await allResting()) {
        const m = all2[o.coin];
        if (m) await xchg(cancelAction([{ a: m.asset, o: o.oid }]));
      }
      for (const p of (await perpState()).positions) {
        const m = all2[p.coin];
        if (m && p.szi !== 0) await xchg(orderAction([wire(m.asset, p.szi < 0, fmtPx(m.mark * (p.szi < 0 ? 1.02 : 0.98), m.szDecimals), fmtSz(Math.abs(p.szi), m.szDecimals), true, 'Ioc')]));
      }
      const fin = await perpState();
      console.log(`  resting=${(await allResting()).length}  positions=${JSON.stringify(fin.positions)}`);
      note('finalState', { resting: (await allResting()).length, positions: fin.positions });
    } catch (e) { console.error('  ⚠️  CLEANUP FAILED — check the testnet UI manually:', e); }
  }

  // ── analyses ──────────────────────────────────────────────────────────────────────
  // T5: flat-account stops
  const t5: any = {};
  for (const k of ['flatSell', 'flatBuy']) {
    const t = tracked.get(k);
    if (!t) { t5[k] = 'not placed'; continue; }
    const statuses = [...new Set(t.samples.map(s => s.status))];
    const lastOpen = [...t.samples].reverse().find(s => s.status === 'open');
    t5[k] = { oid: t.oid, samples: t.samples.length, statusesSeen: statuses, everCanceled: statuses.some(s => s && s !== 'open'), stillOpenAtLastSample: t.samples.at(-1)?.status === 'open', lastOpenText: lastOpen?.row?.triggerCondition ?? null };
  }
  t5.observedSeconds = tracked.get('flatSell')?.samples.length ? Math.round((Date.parse(tracked.get('flatSell')!.samples.at(-1)!.t) - Date.parse(tracked.get('flatSell')!.samples[0].t)) / 1000) : 0;
  note('t5', t5);

  // T2: webData2
  const t2: any = { frameKeys: web2Keys, frames: web2.length, perOid: {} };
  for (const k of ['flatSell', 'flatBuy', 't3', 'w2sell', 'w2buy']) {
    const t = tracked.get(k);
    if (!t) continue;
    const inWeb = web2.filter(f => f.ours.some(o => o.oid === t.oid));
    const webTexts = [...new Set(inWeb.map(f => f.ours.find(o => o.oid === t.oid)?.triggerCondition))];
    const pollTexts = [...new Set(t.samples.map(s => s.row?.triggerCondition).filter(Boolean))];
    const sampleRow = inWeb.length ? inWeb[inWeb.length - 1].ours.find(o => o.oid === t.oid) : null;
    const frontRow = [...t.samples].reverse().find(s => s.row)?.row ?? null;
    t2.perOid[k] = {
      oid: t.oid, framesContainingIt: inWeb.length, distinctTextsInWebData2: webTexts, distinctTextsInFrontendOpenOrdersPolls: pollTexts,
      webData2FollowsRatchet: pollTexts.length > 1 ? webTexts.length > 1 : 'n/a (mark did not move)',
      rowKeysEqualFrontendRow: sampleRow && frontRow ? JSON.stringify(Object.keys(sampleRow)) === JSON.stringify(Object.keys(frontRow)) : null,
      webData2Row: sampleRow,
    };
  }
  note('t2', t2);

  // T3 transitions
  const t3s = tracked.get('t3');
  if (t3s) {
    const trans: any[] = [];
    let last = '';
    for (const s of t3s.samples) {
      const k = `${s.row?.triggerCondition}|${s.row?.triggerPx}|${s.status}`;
      if (k !== last) { trans.push({ t: s.t, mark: s.mark, status: s.status, triggerCondition: s.row?.triggerCondition, triggerPx: s.row?.triggerPx, limitPx: s.row?.limitPx }); last = k; }
    }
    note('t3', { oid: t3s.oid, transitions: trans, activated: trans.some(t => /best [0-9]/.test(t.triggerCondition ?? '')) });
  }

  // T9 expiry outcome
  const t9s = tracked.get('t9a');
  if (t9s) {
    const afterExp = t9s.samples.filter(s => Date.parse(s.t) > S.t9?.expiresAfter);
    S.t9 = { ...S.t9, samplesAfterExpiry: afterExp.length, statusesAfterExpiry: [...new Set(afterExp.map(s => s.status))], stillOpenAfterExpiry: afterExp.length ? afterExp.at(-1)!.status === 'open' : null };
  }

  saveR('tracked_samples', Object.fromEntries([...tracked.entries()].map(([k, v]) => [k, v])));
  saveR('webdata2_frames', { keys: web2Keys, total: web2.length, first: web2[0] ?? null, last: web2.at(-1) ?? null, frames: web2.slice(0, 400) });
  saveR('ws_events', { count: wsFrames.length, events: wsFrames, channelCounts: wsChannelCounts, raw: wsRaw });
  S.finishedAt = new Date().toISOString();
  S.wsChannelCounts = wsChannelCounts;
  save(`${TAG}_summary.json`, S);
  try { wsRef?.close(); } catch { /* ignore */ }
  console.log(`\n✅ Round 6 (${ONLY || 'full'}) done. Summary: scripts/captures/${TAG}_summary.json`);
  process.exit(0);
}

main().catch(err => { console.error('\n❌ Probe failed:', err); process.exit(1); });
