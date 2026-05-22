/**
 * probe-hl-testnet.ts
 *
 * PURPOSE: Call HL testnet to capture exact request/response JSON shapes
 * for 3 missing HyPaper actions: modify, batchModify, twapOrder.
 *
 * SETUP — .env must have:
 *   HL_TESTNET_PRIVATE_KEY=0x...
 *   HL_TESTNET_WALLET=0x4A1AE5A6cFB24390a704b1cc1aB88d0F89eF596B
 *
 * RUN:
 *   npx tsx scripts/probe-hl-testnet.ts
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

// We will look up BTC's asset index dynamically from the universe array
// because testnet asset ordering differs from mainnet (index 0 is NOT BTC).
let BTC_ASSET = -1;

const PRIVATE_KEY = process.env.HL_TESTNET_PRIVATE_KEY as `0x${string}` | undefined;
const WALLET_ADDR = process.env.HL_TESTNET_WALLET      as `0x${string}` | undefined;

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

function fmtPx(price: number, tickSize: number): string {
  // Round to nearest tick, no trailing zeros.
  // For tickSize=1 this always produces whole numbers e.g. "70354"
  // For tickSize=0.1 this produces one decimal e.g. "70353.9"
  // We use Math.round then toFixed to avoid floating-point drift like 70353.900000001
  const decimals = tickSize >= 1 ? 0 : Math.round(-Math.log10(tickSize));
  const rounded  = Math.round(price / tickSize) * tickSize;
  return parseFloat(rounded.toFixed(decimals)).toString();
}

function fmtSz(size: number, szDecimals: number): string {
  return parseFloat(size.toFixed(szDecimals)).toString();
}

// ─── Action builders ──────────────────────────────────────────────────────────
// Field order MUST match Python SDK exactly — msgpack is order-sensitive.

function wire(asset: number, isBuy: boolean, price: string, size: string, reduceOnly: boolean, tif: 'Gtc' | 'Ioc' | 'Alo') {
  return { a: asset, b: isBuy, p: price, s: size, r: reduceOnly, t: { limit: { tif } } };
}
function orderAction(orders: ReturnType<typeof wire>[], grouping = 'na') {
  return { type: 'order', orders, grouping };
}
function modifyAction(oid: number, order: ReturnType<typeof wire>) {
  return { type: 'modify', oid, order };
}
function batchModifyAction(modifies: Array<{ oid: number; order: ReturnType<typeof wire> }>) {
  return { type: 'batchModify', modifies };
}
function twapAction(asset: number, isBuy: boolean, size: string, reduceOnly: boolean, minutes: number, randomize: boolean) {
  return { type: 'twapOrder', twap: { a: asset, b: isBuy, s: size, r: reduceOnly, m: minutes, t: randomize } };
}
function twapCancelAction(asset: number, twapId: number) {
  return { type: 'twapCancel', a: asset, t: twapId };
}
function cancelAction(cancels: Array<{ a: number; o: number }>) {
  return { type: 'cancel', cancels };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function save(filename: string, data: { request: unknown; response: unknown }) {
  mkdirSync(CAPTURES_DIR, { recursive: true });
  writeFileSync(resolve(CAPTURES_DIR, filename), JSON.stringify(data, null, 2));
  console.log(`  ✅ Saved: scripts/captures/${filename}`);
}

async function doExchange(
  account: ReturnType<typeof privateKeyToAccount>,
  action: unknown,
): Promise<{ requestBody: unknown; response: unknown }> {
  const nonce     = Date.now();
  const signature = await signL1Action(account, action, nonce);
  const body      = { action, nonce, signature };
  const res = await fetch(EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { requestBody: body, response: JSON.parse(text) };
  } catch {
    throw new Error(`Exchange returned non-JSON: ${text.slice(0, 200)}`);
  }
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
    throw new Error(`infoPost(${JSON.stringify(query)}) returned non-JSON: ${text.slice(0, 200)}`);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY!);

  console.log('\n🔬 Hyperliquid Testnet Probe');
  console.log('============================');
  console.log(`Wallet : ${account.address}`);

  if (account.address.toLowerCase() !== WALLET_ADDR!.toLowerCase()) {
    console.error(`\n❌ Key mismatch. Set HL_TESTNET_WALLET=${account.address}\n`);
    process.exit(1);
  }
  console.log('✅ Key matches.\n');

  // ── Fetch meta + find BTC asset index ────────────────────────────────────
  //
  // IMPORTANT: testnet asset ordering differs from mainnet.
  // On testnet index 0 is SOL (oracle ~$86), NOT BTC.
  // We must look up BTC by name in the universe array.
  //
  // metaAndAssetCtxs returns a two-element array:
  //   [0] = { universe: [{ name, szDecimals, maxLeverage }, ...] }
  //   [1] = [ { oraclePx, markPx, ... }, ... ]  ← same index as universe

  console.log('📊 Fetching metaAndAssetCtxs...');
  const mac = await infoPost({ type: 'metaAndAssetCtxs' }) as [
    { universe: Array<{ name: string; szDecimals: number; maxLeverage: number }> },
    Array<{ oraclePx: string; markPx: string; funding: string }>
  ];

  const universe  = mac[0].universe;
  const assetCtxs = mac[1];

  // Print first 10 assets so we can see what's on testnet
  console.log('  First 10 testnet assets:');
  universe.slice(0, 10).forEach((a, i) => {
    console.log(`    [${i}] ${a.name.padEnd(6)} oracle=$${parseFloat(assetCtxs[i]?.oraclePx ?? '0').toLocaleString()}`);
  });

  // Find BTC by name
  BTC_ASSET = universe.findIndex(a => a.name === 'BTC');
  if (BTC_ASSET === -1) {
    console.error('\n❌ BTC not found in testnet universe. Cannot continue.');
    process.exit(1);
  }

  const btcMeta    = universe[BTC_ASSET];
  const btcCtx     = assetCtxs[BTC_ASSET];
  const szDecimals = btcMeta.szDecimals;
  const minSz      = 1 / Math.pow(10, szDecimals);
  const oraclePx   = parseFloat(btcCtx.oraclePx);
  const markPx     = parseFloat(btcCtx.markPx);

  // BTC testnet tick size = 1 (whole numbers only).
  // Confirmed from HL errors whenever decimals were sent.
  // The API returns prices like "78225.0" which has a dot but tick is still 1.
  const tickSize = 1;

  console.log(`\n  BTC asset index : ${BTC_ASSET}`);
  console.log(`  szDecimals      : ${szDecimals}  (min size = ${minSz} BTC)`);
  console.log(`  oraclePx        : $${oraclePx.toLocaleString()}`);
  console.log(`  markPx          : $${markPx.toLocaleString()}`);
  console.log(`  tick size       : $${tickSize}`);

  // ── Compute sizes ─────────────────────────────────────────────────────────
  //
  // HL minimum order value = $10 per order.
  // minOrderSz = ceil($10 / oraclePx / minSz) * minSz
  // We use 3× that to be comfortably above the minimum.

  const minOrderSzRaw = 10 / oraclePx;
  const minOrderSz    = Math.ceil(minOrderSzRaw / minSz) * minSz;
  const orderSzNum    = minOrderSz * 3;  // 3× minimum = safely above $10
  const orderSz       = fmtSz(orderSzNum, szDecimals);
  const orderNotional = orderSzNum * oraclePx;

  // TWAP minimum = $50 total ($10/min × 5 min)
  // Use enough for $150 notional to be safely above $50
  const minTwapSzRaw = 150 / oraclePx;
  const twapSzNum    = Math.ceil(minTwapSzRaw / minSz) * minSz;
  const twapSz       = fmtSz(twapSzNum, szDecimals);
  const twapNotional = twapSzNum * oraclePx;

  console.log(`\n  Order size  : ${orderSz} BTC (~$${orderNotional.toFixed(2)} at oracle) [need >$10]`);
  console.log(`  TWAP size   : ${twapSz} BTC (~$${twapNotional.toFixed(2)} at oracle) [need >$50]`);

  // ── Compute resting prices ────────────────────────────────────────────────
  //
  // Place buy limit orders 10% below oracle.
  // HL allows orders up to 20% away from oracle for resting orders.
  // 10% below = safely within band, won't fill (oracle >> testnet mark)...

  const p1    = fmtPx(oraclePx * 0.90, tickSize);
  const p2    = fmtPx(oraclePx * 0.89, tickSize);
  const p1mod = fmtPx(oraclePx * 0.905, tickSize);
  const p1b   = fmtPx(oraclePx * 0.901, tickSize);
  const p2b   = fmtPx(oraclePx * 0.891, tickSize);

  console.log(`  Resting p1  : $${p1}  (10% below oracle)`);
  console.log(`  Resting p2  : $${p2}  (11% below oracle)\n`);

  // ── STEP 1: Place two resting limit orders ────────────────────────────────

  console.log('📤 Step 1: Place two resting GTC limit orders...');
  const r1 = await doExchange(account, orderAction([
    wire(BTC_ASSET, true, p1, orderSz, false, 'Gtc'),
    wire(BTC_ASSET, true, p2, orderSz, false, 'Gtc'),
  ]));
  save('01_place_order.json', { request: r1.requestBody, response: r1.response });
  console.log('  Response:', JSON.stringify(r1.response, null, 2));

  const statuses = (r1.response as any)?.response?.data?.statuses ?? [];
  const oid1: number | null = statuses[0]?.resting?.oid ?? null;
  const oid2: number | null = statuses[1]?.resting?.oid ?? null;

  if (!oid1 || !oid2) {
    console.error('\n❌ No resting OIDs. Skipping modify/batchModify.');
    console.error('   See response above for the exact HL error.\n');
  } else {
    console.log(`  ✅ OID1=${oid1}  OID2=${oid2}`);
    await sleep(600);

    // ── STEP 2: modify ────────────────────────────────────────────────────

    console.log('\n📤 Step 2: modify OID1 (change price slightly)...');
    const r2 = await doExchange(account, modifyAction(
      oid1,
      wire(BTC_ASSET, true, p1mod, orderSz, false, 'Gtc'),
    ));
    save('02_modify.json', { request: r2.requestBody, response: r2.response });
    console.log('  Response:', JSON.stringify(r2.response, null, 2));
    await sleep(600);

    // ── STEP 3: batchModify ───────────────────────────────────────────────

    console.log('\n📤 Step 3: batchModify OID1 + OID2...');
    const r3 = await doExchange(account, batchModifyAction([
      { oid: oid1, order: wire(BTC_ASSET, true, p1b, orderSz, false, 'Gtc') },
      { oid: oid2, order: wire(BTC_ASSET, true, p2b, orderSz, false, 'Gtc') },
    ]));
    save('03_batchModify.json', { request: r3.requestBody, response: r3.response });
    console.log('  Response:', JSON.stringify(r3.response, null, 2));
    await sleep(600);

    // ── STEP 3b: cancel ───────────────────────────────────────────────────

    console.log('\n🧹 Cancel both resting orders...');
    const r3b = await doExchange(account, cancelAction([
      { a: BTC_ASSET, o: oid1 },
      { a: BTC_ASSET, o: oid2 },
    ]));
    save('03b_cancel.json', { request: r3b.requestBody, response: r3b.response });
    console.log('  Response:', JSON.stringify(r3b.response, null, 2));
    await sleep(600);
  }

  // ── STEP 4: twapOrder ────────────────────────────────────────────────────

  console.log(`\n📤 Step 4: twapOrder — ${twapSz} BTC / 5 min (~$${twapNotional.toFixed(2)})...`);
  const r4 = await doExchange(account, twapAction(BTC_ASSET, true, twapSz, false, 5, false));
  save('04_twapOrder.json', { request: r4.requestBody, response: r4.response });
  console.log('  Response:', JSON.stringify(r4.response, null, 2));

  const twapId: number | null =
    (r4.response as any)?.response?.data?.status?.running?.twapId ?? null;
  await sleep(1000);

  // ── STEP 5: twapCancel ───────────────────────────────────────────────────

  console.log('\n📤 Step 5: twapCancel...');
  if (!twapId) {
    console.warn('  ⚠️  No twapId — TWAP did not start. See 04_twapOrder.json.');
    save('05_twapCancel.json', { request: { skipped: true, reason: 'no twapId' }, response: null });
  } else {
    console.log(`  twapId: ${twapId}`);
    const r5 = await doExchange(account, twapCancelAction(BTC_ASSET, twapId));
    save('05_twapCancel.json', { request: r5.requestBody, response: r5.response });
    console.log('  Response:', JSON.stringify(r5.response, null, 2));
  }

  await sleep(600);

  // ── STEP 6–9: info reads ──────────────────────────────────────────────────

  console.log('\n📥 Step 6: frontendOpenOrders...');
  const q6 = { type: 'frontendOpenOrders', user: WALLET_ADDR };
  save('06_openOrders.json', { request: q6, response: await infoPost(q6) });
  console.log('  Saved.');

  console.log('\n📥 Step 7: userFills...');
  const q7   = { type: 'userFills', user: WALLET_ADDR };
  const fills = await infoPost(q7);
  save('07_userFills.json', { request: q7, response: fills });
  console.log(`  Total fills: ${Array.isArray(fills) ? fills.length : 0}`);

  console.log('\n📤 Step 8: modify OID 99999999 — capture error shape...');
  const r8 = await doExchange(account, modifyAction(
    99999999,
    wire(BTC_ASSET, true, p1, orderSz, false, 'Gtc'),
  ));
  save('08_modify_error.json', { request: r8.requestBody, response: r8.response });
  console.log('  Response:', JSON.stringify(r8.response, null, 2));

  console.log('\n📥 Step 9: clearinghouseState...');
  const q9    = { type: 'clearinghouseState', user: WALLET_ADDR };
  const state = await infoPost(q9);
  save('09_clearinghouseState.json', { request: q9, response: state });
  console.log('  accountValue:', (state as any)?.marginSummary?.accountValue ?? 'n/a');

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log('\n✅ Done! scripts/captures/ contains:\n');
  console.log('  01_place_order.json         resting order response shape');
  console.log('  02_modify.json              modify success shape   ← needed for HyPaper');
  console.log('  03_batchModify.json         batchModify success    ← needed for HyPaper');
  console.log('  03b_cancel.json             cancel confirmation');
  console.log('  04_twapOrder.json           twapOrder + twapId     ← needed for HyPaper');
  console.log('  05_twapCancel.json          twapCancel shape');
  console.log('  06_openOrders.json          frontendOpenOrders fields');
  console.log('  07_userFills.json           userFills all fields');
  console.log('  08_modify_error.json        modify error shape');
  console.log('  09_clearinghouseState.json  account balance + positions\n');
}

main().catch(err => { console.error('\n💥', err); process.exit(1); });