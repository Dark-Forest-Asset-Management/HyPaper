/**
 * probe-hl-twap-history.ts
 *
 * PURPOSE: Probe real HL testnet for the EXACT wire shapes of `twapHistory`
 * and `userTwapSliceFills` against a wallet that has actually run a TWAP.
 *
 * Why this script exists: HyPaper's `twapHistory` field names
 * (store/schema.ts twapHistory table, pg-queries.ts getTwapHistoryPg) were
 * written from inference, NOT a captured prod response — there was no
 * existing capture for it in scripts/captures/. This script closes that
 * gap so the shape can be verified instead of assumed.
 *
 * Signing is copy-pasted from probe-hl-testnet.ts on purpose (same EIP-712
 * domain/types, same msgpack action-hash, same viem account) so this
 * capture is apples-to-apples comparable with 04_twapOrder.json /
 * 05_twapCancel.json, which came from that exact code path. There is no
 * separate `lib/hl-signing.js` helper in this project — every probe script
 * inlines its own signing, so this one does too.
 *
 * SETUP — .env must have:
 *   HL_TESTNET_PRIVATE_KEY=0x...
 *   HL_TESTNET_WALLET=0x4A1AE5A6cFB24390a704b1cc1aB88d0F89eF596B
 *
 * RUN:
 *   npx tsx scripts/probe-hl-twap-history.ts
 *
 * What it does:
 *   1. Places a real TWAP order on HL testnet (5-minute minimum duration).
 *   2. Waits ~40s so at least one suborder has had a chance to fill.
 *   3. Queries `userTwapSliceFills` and dumps the raw response.
 *   4. Cancels the TWAP (so we don't have to wait the full 5 minutes).
 *   5. Queries `twapHistory` and dumps the raw response.
 *   6. Writes both raw responses to scripts/captures/ following the
 *      existing numbered-capture convention.
 *
 * This does NOT touch HyPaper itself — it talks directly to real HL
 * testnet, exactly like probe-hl-testnet.ts does.
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

const PRIVATE_KEY = process.env.HL_TESTNET_PRIVATE_KEY as `0x${string}` | undefined;
const WALLET_ADDR = process.env.HL_TESTNET_WALLET      as `0x${string}` | undefined;

if (!PRIVATE_KEY || !WALLET_ADDR) {
  console.error('ERROR: Set HL_TESTNET_PRIVATE_KEY and HL_TESTNET_WALLET in .env');
  process.exit(1);
}

// Pick a cheap, liquid testnet asset/size so the TWAP notional stays small.
// We look up BTC dynamically (testnet asset ordering != mainnet) and size
// the TWAP comfortably above HL's $50 TWAP minimum, same as probe-hl-testnet.ts.
let BTC_ASSET = -1;
const TWAP_MINUTES = 5; // HL's real documented minimum — confirmed by the
                         // route validation already enforcing the same floor

// ─── EIP-712 (identical to probe-hl-testnet.ts) ───────────────────────────────

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

// ─── Signing (identical to probe-hl-testnet.ts) ───────────────────────────────

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

// ─── Action builders ──────────────────────────────────────────────────────────

function twapAction(asset: number, isBuy: boolean, size: string, reduceOnly: boolean, minutes: number, randomize: boolean) {
  return { type: 'twapOrder', twap: { a: asset, b: isBuy, s: size, r: reduceOnly, m: minutes, t: randomize } };
}
function twapCancelAction(asset: number, twapId: number) {
  return { type: 'twapCancel', a: asset, t: twapId };
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY!);

  console.log('\n🔬 Hyperliquid Testnet Probe — twapHistory / userTwapSliceFills');
  console.log('==================================================================');
  console.log(`Wallet : ${account.address}`);

  if (account.address.toLowerCase() !== WALLET_ADDR!.toLowerCase()) {
    console.error(`\n❌ Key mismatch. Set HL_TESTNET_WALLET=${account.address}\n`);
    process.exit(1);
  }
  console.log('✅ Key matches.\n');

  // ── Fetch meta + find BTC asset index, same lookup as probe-hl-testnet.ts ──

  console.log('📊 Fetching metaAndAssetCtxs...');
  const mac = await infoPost({ type: 'metaAndAssetCtxs' }) as [
    { universe: Array<{ name: string; szDecimals: number; maxLeverage: number }> },
    Array<{ oraclePx: string; markPx: string; funding: string }>
  ];

  const universe  = mac[0].universe;
  const assetCtxs = mac[1];

  BTC_ASSET = universe.findIndex((a) => a.name === 'BTC');
  if (BTC_ASSET === -1) {
    console.error('\n❌ BTC not found in testnet universe. Cannot continue.');
    process.exit(1);
  }

  const btcMeta    = universe[BTC_ASSET];
  const szDecimals = btcMeta.szDecimals;
  const minSz      = 1 / Math.pow(10, szDecimals);
  const oraclePx   = parseFloat(assetCtxs[BTC_ASSET].oraclePx);

  // TWAP minimum = $50 total ($10/min × 5 min). Use ~$150 to be safely above it.
  const minTwapSzRaw = 150 / oraclePx;
  const twapSzNum    = Math.ceil(minTwapSzRaw / minSz) * minSz;
  const twapSz       = parseFloat(twapSzNum.toFixed(szDecimals)).toString();
  const twapNotional = twapSzNum * oraclePx;

  console.log(`  BTC asset index : ${BTC_ASSET}`);
  console.log(`  oraclePx        : $${oraclePx.toLocaleString()}`);
  console.log(`  TWAP size       : ${twapSz} BTC (~$${twapNotional.toFixed(2)}) [need >$50]\n`);

  // ── STEP 1: Place the TWAP order ──────────────────────────────────────────

  console.log(`📤 [1/6] Placing TWAP order: asset=${BTC_ASSET} size=${twapSz} minutes=${TWAP_MINUTES}`);
  const r1 = await doExchange(account, twapAction(BTC_ASSET, true, twapSz, false, TWAP_MINUTES, false));
  console.log('  Response:', JSON.stringify(r1.response, null, 2));

  if ((r1.response as any)?.status !== 'ok') {
    throw new Error(`TWAP placement failed: ${JSON.stringify(r1.response)}`);
  }
  const twapId: number | null =
    (r1.response as any)?.response?.data?.status?.running?.twapId ?? null;
  if (!twapId) {
    throw new Error(`No twapId in response: ${JSON.stringify(r1.response)}`);
  }
  console.log(`  twapId = ${twapId}`);

  // ── STEP 2: Wait for at least one suborder to fill ────────────────────────

  console.log('\n⏳ [2/6] Waiting 40s for at least one suborder to fill...');
  await sleep(40_000);

  // ── STEP 3: userTwapSliceFills ─────────────────────────────────────────────

  console.log('\n📥 [3/6] Querying userTwapSliceFills...');
  const sliceFillsQuery = { type: 'userTwapSliceFills', user: WALLET_ADDR };
  const sliceFillsResp  = await infoPost(sliceFillsQuery);
  console.log('  userTwapSliceFills raw response:', JSON.stringify(sliceFillsResp, null, 2));
  save('28_userTwapSliceFills.json', { request: sliceFillsQuery, response: sliceFillsResp });

  // ── STEP 4: Cancel the TWAP ─────────────────────────────────────────────────

  console.log('\n📤 [4/6] Cancelling the TWAP...');
  const r4 = await doExchange(account, twapCancelAction(BTC_ASSET, twapId));
  console.log('  Cancel response:', JSON.stringify(r4.response, null, 2));

  // ── STEP 5: twapHistory ──────────────────────────────────────────────────────

  console.log('\n📥 [5/6] Querying twapHistory (after a short delay for the write to land)...');
  await sleep(3_000);
  const historyQuery = { type: 'twapHistory', user: WALLET_ADDR };
  const historyResp  = await infoPost(historyQuery);
  console.log('  twapHistory raw response:', JSON.stringify(historyResp, null, 2));
  save('29_twapHistory.json', { request: historyQuery, response: historyResp });

  console.log('\n✅ [6/6] Done. Captures written to:');
  console.log('  scripts/captures/28_userTwapSliceFills.json');
  console.log('  scripts/captures/29_twapHistory.json');
}

main().catch((err) => {
  console.error('\n💥 Probe failed:', err);
  process.exit(1);
});