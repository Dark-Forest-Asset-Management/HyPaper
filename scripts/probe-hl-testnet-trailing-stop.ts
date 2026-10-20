/**
 * probe-hl-testnet-trailing-stop.ts
 *
 * PURPOSE: Capture the exact HL wire shape + lifecycle of TRAILING STOP orders
 * on HL TESTNET, so they can later be implemented in HyPaper (paper mode) and
 * slushy.trade (live mode). PROBE ONLY — no HyPaper/feature code is touched.
 *
 * WIRE SHAPE (confirmed from real testnet-UI captures + offline signer recovery):
 *   {
 *     type: 'trailingStop',          // its OWN action type, NOT inside `order`
 *     asset, isBuy, sz, reduceOnly,
 *     retracement: { px: '3000' } | { pct: '5.0000%' },
 *     activationPx: null | '86218'
 *   }
 *   response: { status:'ok', response:{ type:'trailingStop', data:{ oid } } }
 *
 *   msgpack field order (load-bearing — only this order recovers the real
 *   signer; the browser's JSON is key-sorted and misleading):
 *     type, asset, isBuy, sz, reduceOnly, retracement, activationPx
 *
 * VARIANTS (6) — long position is opened first for the closing variants:
 *   1 CLOSE  distance (px)  no activation
 *   2 CLOSE  percentage     no activation
 *   3 CLOSE  distance (px)  activation ABOVE mark
 *   4 OPEN   distance (px)  no activation
 *   5 OPEN   percentage     no activation
 *   6 OPEN   distance (px)  activation BELOW mark
 * plus invalid-order probes (error message format) and a live polling phase
 * that records whether trigger/watermark fields move as mark moves.
 *
 * SETUP — .env must have:
 *   HL_TESTNET_PRIVATE_KEY=0x...
 *   HL_TESTNET_WALLET=0x...
 *
 * RUN:
 *   npx tsx scripts/probe-hl-testnet-trailing-stop.ts
 *
 * OPTIONAL ENV:
 *   PROBE_COIN=BTC          coin to trade (default BTC)
 *   POLL_INTERVAL_S=15      seconds between polls   (default 15)
 *   POLL_DURATION_S=240     total polling seconds   (default 240)
 *   DRY_RUN=1               build + sign + print payloads, send nothing
 *
 * OUTPUT: scripts/captures/30_*.json … (same {request, response} format as
 * the earlier probes, plus `meta` / follow-up keys) and
 * scripts/captures/trailing-stop-summary.json (machine-readable roll-up).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { keccak256, toHex } from 'viem';
import { config as dotenvConfig } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '../.env') });

// ─── Config ───────────────────────────────────────────────────────────────────

const TESTNET_API  = 'https://api.hyperliquid-testnet.xyz';
const EXCHANGE_URL = `${TESTNET_API}/exchange`;
const INFO_URL     = `${TESTNET_API}/info`;
const CAPTURES_DIR = resolve(__dirname, 'captures');

const COIN             = process.env.PROBE_COIN ?? 'BTC';
const POLL_INTERVAL_S  = Number(process.env.POLL_INTERVAL_S ?? 15);
const POLL_DURATION_S  = Number(process.env.POLL_DURATION_S ?? 240);
const DRY_RUN          = process.env.DRY_RUN === '1';

const PRIVATE_KEY = process.env.HL_TESTNET_PRIVATE_KEY as `0x${string}` | undefined;
const WALLET_ADDR = process.env.HL_TESTNET_WALLET      as `0x${string}` | undefined;

// TESTNET-ONLY GUARD. Hard stop if either URL is anything but testnet.
for (const url of [EXCHANGE_URL, INFO_URL]) {
  if (!/^https:\/\/api\.hyperliquid-testnet\.xyz\//.test(url)) {
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

function actionPreimage(action: unknown, nonce: number): Uint8Array {
  const packed     = msgpackEncode(action);
  const nonceBuf   = new ArrayBuffer(8);
  new DataView(nonceBuf).setBigUint64(0, BigInt(nonce), false);
  const nonceBytes = new Uint8Array(nonceBuf);
  const vaultFlag  = new Uint8Array([0]);
  const combined   = new Uint8Array(packed.length + nonceBytes.length + vaultFlag.length);
  combined.set(packed,     0);
  combined.set(nonceBytes, packed.length);
  combined.set(vaultFlag,  packed.length + nonceBytes.length);
  return combined;
}

function actionHash(action: unknown, nonce: number): `0x${string}` {
  return keccak256(toHex(actionPreimage(action, nonce)));
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

/**
 * HL perp price rule: max 5 significant figures AND at most (6 - szDecimals)
 * decimals; integers are always allowed. No trailing zeros on the wire.
 */
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
  // Order verified by offline signer recovery against 3 real UI captures.
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

// ─── Market helpers ───────────────────────────────────────────────────────────

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

// ─── Variants ─────────────────────────────────────────────────────────────────

interface VariantSpec {
  n: number; slug: string; label: string;
  isBuy: boolean; reduceOnly: boolean;
  kind: 'px' | 'pct'; activation: 'none' | 'above' | 'below';
}

const VARIANTS: VariantSpec[] = [
  { n: 1, slug: 'close_px',        label: 'CLOSE long, fixed distance, no activation',    isBuy: false, reduceOnly: true,  kind: 'px',  activation: 'none'  },
  { n: 2, slug: 'close_pct',       label: 'CLOSE long, percentage, no activation',        isBuy: false, reduceOnly: true,  kind: 'pct', activation: 'none'  },
  { n: 3, slug: 'close_px_act',    label: 'CLOSE long, fixed distance, activation ABOVE', isBuy: false, reduceOnly: true,  kind: 'px',  activation: 'above' },
  { n: 4, slug: 'open_px',         label: 'OPEN long, fixed distance, no activation',     isBuy: true,  reduceOnly: false, kind: 'px',  activation: 'none'  },
  { n: 5, slug: 'open_pct',        label: 'OPEN long, percentage, no activation',         isBuy: true,  reduceOnly: false, kind: 'pct', activation: 'none'  },
  { n: 6, slug: 'open_px_act',     label: 'OPEN long, fixed distance, activation BELOW',  isBuy: true,  reduceOnly: false, kind: 'px',  activation: 'below' },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY!);

  console.log('\n🔬 Hyperliquid Testnet Probe — TRAILING STOP');
  console.log('=============================================');
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
  console.log(`  ${COIN} asset index : ${asset}  szDecimals=${szDecimals}`);
  console.log(`  markPx / oracle : $${mkt.markPx} / $${mkt.oraclePx}`);

  // Size: ~$12 notional (above HL's $10 minimum), identical for every variant
  // so one position of this size can be closed by each closing stop.
  const sz = fmtSz(Math.ceil(12 / mkt.markPx / minSz) * minSz, szDecimals);
  console.log(`  size per order  : ${sz} ${COIN} (~$${(parseFloat(sz) * mkt.markPx).toFixed(2)})\n`);

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

  const summary: Record<string, unknown> = {
    coin: COIN, asset, szDecimals, sz, startedAt: new Date().toISOString(), dryRun: DRY_RUN, variants: {},
  };
  const placed: Array<{ spec: VariantSpec; oid: number; action: any }> = [];

  try {
    // ── Setup: open a small long (for the closing variants) ────────────────
    console.log('📤 Setup: open long via IOC buy through the book...');
    const entryPx = fmtPx(mkt.markPx * 1.02, szDecimals);
    const e = await doExchange(account, orderAction([wire(asset, true, entryPx, sz, false, 'Ioc')]));
    save('30_trailing_00_setup_long.json', {
      request: e.requestBody, response: e.response, httpStatus: e.httpStatus, meta: e.meta,
    });
    console.log('  Response:', JSON.stringify(e.response));
    const filled = (e.response as any)?.response?.data?.statuses?.[0]?.filled;
    if (!DRY_RUN && !filled) {
      throw new Error('Setup long did not fill — see 30_trailing_00_setup_long.json');
    }
    await sleep(800);

    // ── Fresh mark for deriving distances / activation prices ──────────────
    const m2 = DRY_RUN ? mkt : await getMarket();
    const mark = m2.markPx;
    const distPx   = String(Math.round(mark * 0.03));    // ~3 % of mark, whole number like the UI captures
    const pctStr   = '5.0000%';                          // matches UI wire format exactly
    const actAbove = fmtPx(mark * 1.03, szDecimals);     // above mark (close-long variant)
    const actBelow = fmtPx(mark * 0.97, szDecimals);     // below mark (open-long variant)
    console.log(`\n  mark=${mark}  distPx=${distPx}  pct=${pctStr}  actAbove=${actAbove}  actBelow=${actBelow}\n`);

    // ── Place the 6 variants ───────────────────────────────────────────────
    for (const spec of VARIANTS) {
      console.log(`📤 Variant ${spec.n}: ${spec.label}`);
      const retracement: Retracement = spec.kind === 'px' ? { px: distPx } : { pct: pctStr };
      const activationPx = spec.activation === 'above' ? actAbove : spec.activation === 'below' ? actBelow : null;
      const action = trailingStopAction(asset, spec.isBuy, sz, spec.reduceOnly, retracement, activationPx);

      const r = await doExchange(account, action);
      const oid = extractOid(r.response);
      console.log(`  HTTP ${r.httpStatus}  Response: ${JSON.stringify(r.response)}`);

      // Follow-up queries while the order is resting.
      await sleep(700);
      const followUps: Record<string, unknown> = {};
      if (!DRY_RUN) {
        followUps.openOrders         = await infoPost({ type: 'openOrders', user: WALLET_ADDR });
        followUps.frontendOpenOrders = await infoPost({ type: 'frontendOpenOrders', user: WALLET_ADDR });
        if (oid !== null) followUps.orderStatus = await infoPost({ type: 'orderStatus', user: WALLET_ADDR, oid });
      }

      save(`30_trailing_v${spec.n}_${spec.slug}.json`, {
        label: spec.label,
        request: r.requestBody, response: r.response,
        httpStatus: r.httpStatus, rawBody: r.rawBody, meta: r.meta,
        followUps,
      });

      (summary.variants as any)[`v${spec.n}`] = { label: spec.label, oid, httpStatus: r.httpStatus };
      if (oid !== null) placed.push({ spec, oid, action });
      await sleep(600);
    }

    // ── Polling: do trigger/watermark fields move as mark moves? ───────────
    if (!DRY_RUN && placed.length > 0) {
      console.log(`\n⏱  Polling every ${POLL_INTERVAL_S}s for ${POLL_DURATION_S}s...`);
      const ticks: any[] = [];
      const t0 = Date.now();
      while ((Date.now() - t0) / 1000 < POLL_DURATION_S) {
        const mk = await getMarket();
        const fo = await infoPost({ type: 'frontendOpenOrders', user: WALLET_ADDR }) as any[];
        const statuses: Record<number, unknown> = {};
        for (const p of placed) {
          statuses[p.oid] = await infoPost({ type: 'orderStatus', user: WALLET_ADDR, oid: p.oid });
        }
        ticks.push({
          t: new Date().toISOString(),
          markPx: mk.markPx,
          frontendOpenOrders: (Array.isArray(fo) ? fo : []).filter(o => placed.some(p => p.oid === o.oid)),
          orderStatus: statuses,
        });
        console.log(`  [${ticks.length}] mark=${mk.markPx}  resting=${ticks[ticks.length - 1].frontendOpenOrders.length}/${placed.length}`);
        await sleep(POLL_INTERVAL_S * 1000);
      }

      // Did anything about a given order change between ticks?
      const changes: Record<string, { distinctSnapshots: number; markRange: [number, number] }> = {};
      for (const p of placed) {
        const snaps = ticks.map(tk => JSON.stringify(tk.frontendOpenOrders.find((o: any) => o.oid === p.oid) ?? null));
        const marks = ticks.map(tk => tk.markPx);
        changes[`v${p.spec.n}`] = { distinctSnapshots: new Set(snaps).size, markRange: [Math.min(...marks), Math.max(...marks)] };
      }
      save('30_trailing_poll.json', { intervalS: POLL_INTERVAL_S, durationS: POLL_DURATION_S, changes, ticks });
      summary.polling = changes;
      console.log('  Distinct frontendOpenOrders snapshots per variant (1 = static):', JSON.stringify(changes));
    }

    // ── Cancel each trailing stop and save request + response ─────────────
    console.log('\n🧹 Cancelling each trailing stop...');
    for (const p of placed) {
      const c = await doExchange(account, cancelAction([{ a: asset, o: p.oid }]));
      console.log(`  v${p.spec.n} oid=${p.oid}:`, JSON.stringify(c.response));
      save(`30_trailing_v${p.spec.n}_cancel.json`, {
        request: c.requestBody, response: c.response, httpStatus: c.httpStatus, meta: c.meta,
      });
      await sleep(400);
    }
    placed.length = 0;

    // ── Invalid orders: capture HL's error message format ─────────────────
    console.log('\n📤 Invalid-order probes (error format)...');
    const mk3 = DRY_RUN ? mkt : await getMarket();
    const invalid: Array<{ slug: string; label: string; action: any }> = [
      { slug: 'pct_zero',   label: 'percentage retracement 0%',
        action: trailingStopAction(asset, false, sz, true, { pct: '0.0000%' }, null) },
      { slug: 'px_zero',    label: 'distance retracement 0',
        action: trailingStopAction(asset, false, sz, true, { px: '0' }, null) },
      { slug: 'act_wrong_side', label: 'CLOSE long with activation BELOW mark (likely already-past)',
        action: trailingStopAction(asset, false, sz, true, { px: distPx }, fmtPx(mk3.markPx * 0.97, szDecimals)) },
    ];
    for (const iv of invalid) {
      const r = await doExchange(account, iv.action);
      console.log(`  ${iv.slug}: HTTP ${r.httpStatus} ${JSON.stringify(r.response)}`);
      save(`30_trailing_invalid_${iv.slug}.json`, {
        label: iv.label, request: r.requestBody, response: r.response,
        httpStatus: r.httpStatus, rawBody: r.rawBody, meta: r.meta,
      });
      // If HL unexpectedly ACCEPTED it, it is now resting — track for cleanup.
      const oid = extractOid(r.response);
      if (oid !== null) placed.push({ spec: VARIANTS[0], oid, action: iv.action });
      await sleep(500);
    }
  } finally {
    // ── Cleanup: cancel leftovers on this coin, close the test position ────
    if (!DRY_RUN) {
      console.log('\n🧹 Cleanup...');
      try {
        const resting = await getRestingForCoin();
        if (resting.length > 0) {
          const c = await doExchange(account, cancelAction(resting.map(o => ({ a: asset, o: o.oid }))));
          console.log(`  Cancelled ${resting.length} leftover order(s):`, JSON.stringify(c.response));
          save('30_trailing_cleanup_cancel.json', { request: c.requestBody, response: c.response, httpStatus: c.httpStatus });
        }
        const pos = await getPosition();
        if (pos.szi > 0) {
          const m = await getMarket();
          const closePx = fmtPx(m.markPx * 0.98, szDecimals);
          const c = await doExchange(account, orderAction([wire(asset, false, closePx, fmtSz(pos.szi, szDecimals), true, 'Ioc')]));
          console.log('  Closed position:', JSON.stringify(c.response));
          save('30_trailing_cleanup_close.json', { request: c.requestBody, response: c.response, httpStatus: c.httpStatus });
        } else {
          console.log(`  No open ${COIN} long to close (szi=${pos.szi}).`);
        }
        const after = await getPosition();
        console.log(`  Final ${COIN} szi = ${after.szi}`);
      } catch (err) {
        console.error('  ⚠️  CLEANUP FAILED — check testnet UI manually:', err);
      }
    }
    summary.finishedAt = new Date().toISOString();
    save('trailing-stop-summary.json', summary);
  }

  console.log('\n✅ Done. Captures are in scripts/captures/30_trailing_*.json\n');
}

main().catch(err => {
  console.error('\n❌ Probe failed:', err);
  process.exit(1);
});
