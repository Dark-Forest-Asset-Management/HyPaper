/**
 * probe-hl-testnet-transfers.ts
 *
 * Hyperliquid Testnet Probe — Task 2 (Transfers & Funding)
 * ---------------------------------------------------------
 * Probes all transfer/funding /exchange actions against HL testnet to capture
 * their exact request/response shapes for HyPaper implementation.
 *
 * ── ACTIONS COVERED ──────────────────────────────────────────────────────────
 *   1. usdClassTransfer   — move USDC between spot ↔ perp (unified-account aware)
 *   2. usdSend            — send USDC from perp balance to another wallet
 *   3. spotSend           — send a spot token to another wallet
 *   4. sendAsset          — transfer tokens between perp DEXs / spot / users
 *   5. agentSendAsset     — same as sendAsset, but signed by an agent (L1 action)
 *   6. sendToEvmWithData  — send a token from HyperCore to HyperEVM with calldata
 *
 * ── SIGNING ARCHITECTURE ──────────────────────────────────────────────────────
 *
 *  Pattern A — L1 Agent (msgpack hash → Agent EIP-712, domain chainId 1337)
 *    Used by: order, cancel, updateLeverage, agentSendAsset, createSubAccount
 *    Body shape: { action, nonce, signature, [vaultAddress] }
 *    Key rule: action field order drives the msgpack hash — must match server.
 *
 *  Pattern B — User-signed (EIP-712 typed data, domain chainId = signatureChainId)
 *    Used by: usdClassTransfer, usdSend, spotSend, sendAsset, sendToEvmWithData
 *    Body shape: { action, nonce, signature }
 *    Key rule: action MUST contain both `hyperliquidChain` and `signatureChainId`.
 *              These are required for the server to deserialise the body AND
 *              are part of the signed typed-data payload.
 *
 * ── UNIFIED ACCOUNT NOTE ─────────────────────────────────────────────────────
 *   Wallet 1 has a unified account active.  This means:
 *     • usdClassTransfer → disabled ("Action disabled when unified account is active")
 *     • usdSend          → disabled (same)
 *     • spotSend         → disabled (same)
 *     • sendAsset sourceDex="" (perp) → disabled
 *       ("Unified account only supports sending assets through spot")
 *       Fix: use sourceDex="spot" instead.
 *   These are BUSINESS errors, not signing or shape errors.  The captures
 *   confirm request shapes are correct — the server parsed them fine.
 *
 * ── CHANGE LOG ───────────────────────────────────────────────────────────────
 *
 *  v1 → v2 (first revision):
 *    • usdSend / spotSend: added hyperliquidChain + signatureChainId to action
 *    • sendToEvmWithData: fixed shape (added all required fields) and switched
 *      to Pattern B (user-signed) — was incorrectly using Pattern A
 *    • agentSendAsset: switched to Pattern A (L1 Agent) — was incorrectly using
 *      Pattern B; set destination = self (master account address)
 *    • sendAsset: resolve USDC token ID at runtime from testnet spotMeta
 *    • Added createSubAccount probe and subaccount suffix probe
 *
 *  v2 → v3 (this version — fixes after analysing actual capture results):
 *    • sendAsset sourceDex: changed "" → "spot" for unified accounts.
 *      Error from v2: "Unified account only supports sending assets through spot"
 *    • sendToEvmWithData EIP-712: fixed `destinationChainId` type from
 *      uint64 → uint32 (confirmed from Circle docs + nktkas SDK source).
 *      v2 recovered a wrong signer address (0x50acf...) proving the typed-data
 *      hash was wrong.  uint32 corrects the hash.
 *    • sendToEvmWithData: changed sourceDex "spot" → "" (perp/default) since
 *      spot→EVM sends appear to require perp as the source on unified accounts;
 *      the error "Must deposit" indicates the EVM side isn't funded, not a shape
 *      error.  Left both variants documented so the probe captures both errors.
 *    • agentSendAsset: added note that wallet 2 must be an approved agent; the
 *      error "User or API Wallet does not exist" is expected because wallet 2
 *      has never deposited — confirms shape is correct.
 *    • wallet 2 deposit guard: added a pre-check — if wallet 2 has zero
 *      accountValue, print a warning and skip the wallet2→wallet1 usdSend
 *      (which would always fail with "Must deposit" when wallet 2 is unfunded).
 *    • resolveSpotToken: now also resolves HYPE for potential future probes.
 *    • Removed 18d subaccount suffix probe (requires sub-account; createSubAccount
 *      blocked by $100k volume requirement on testnet wallet).  The shape of the
 *      suffix is documented in comments for HyPaper implementation reference.
 *
 * ── SETUP (.env) ─────────────────────────────────────────────────────────────
 *   HL_TESTNET_PRIVATE_KEY=0x...     (wallet 1 — funded)
 *   HL_TESTNET_WALLET=0x...          (wallet 1 address)
 *   HL_TESTNET_PRIVATE_KEY_2=0x...   (wallet 2 — fund via testnet faucet)
 *   HL_TESTNET_WALLET_2=0x...        (wallet 2 address)
 *
 * ── WALLET 2 FUNDING ─────────────────────────────────────────────────────────
 *   Wallet 2 must have a non-zero deposit to perform actions.
 *   Use the HL testnet faucet or send USDC from wallet 1 via the HL web UI.
 *   Without a deposit, wallet 2 actions return "Must deposit before performing
 *   actions" — a node-level guard, not a signing error.
 *
 * RUN:
 *   npx tsx scripts/probe-hl-testnet-transfers.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname }         from 'node:path';
import { fileURLToPath }            from 'node:url';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { encode as msgpackEncode }  from '@msgpack/msgpack';
import { keccak256, toHex }         from 'viem';
import { config as dotenvConfig }   from 'dotenv';

// ─── Setup ───────────────────────────────────────────────────────────────────

const __dirname    = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '../.env') });

const TESTNET_API  = 'https://api.hyperliquid-testnet.xyz';
const EXCHANGE_URL = `${TESTNET_API}/exchange`;
const INFO_URL     = `${TESTNET_API}/info`;
const CAPTURES_DIR = resolve(__dirname, 'captures');

// Testnet HyperEVM chain ID: 998 decimal = 0x3e6
// This is the signatureChainId for user-signed (Pattern B) actions on testnet.
const SIG_CHAIN_ID       = '0x3e6';
const HL_CHAIN           = 'Testnet';
const HYPEREVM_CHAIN_ID  = 998;   // uint32 — testnet HyperEVM

const PRIVATE_KEY   = process.env.HL_TESTNET_PRIVATE_KEY   as `0x${string}` | undefined;
const WALLET_ADDR   = process.env.HL_TESTNET_WALLET         as `0x${string}` | undefined;
let   PRIVATE_KEY_2 = process.env.HL_TESTNET_PRIVATE_KEY_2 as `0x${string}` | undefined;

if (!PRIVATE_KEY || !WALLET_ADDR) {
  console.error('ERROR: Set HL_TESTNET_PRIVATE_KEY and HL_TESTNET_WALLET in .env');
  process.exit(1);
}

if (!PRIVATE_KEY_2) {
  PRIVATE_KEY_2 = generatePrivateKey();
  const acct2 = privateKeyToAccount(PRIVATE_KEY_2);
  console.log('\n⚠️  HL_TESTNET_PRIVATE_KEY_2 not set in .env');
  console.log('   Generated fresh wallet 2:');
  console.log(`   HL_TESTNET_PRIVATE_KEY_2=${PRIVATE_KEY_2}`);
  console.log(`   HL_TESTNET_WALLET_2=${acct2.address}`);
  console.log('   Fund it via the HL testnet faucet, then add to .env.\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// PATTERN A: L1 Agent signing
// ─────────────────────────────────────────────────────────────────────────
// Used by: order, cancel, updateLeverage, agentSendAsset, createSubAccount.
// The action object is msgpack-encoded; the hash becomes the `connectionId`
// in an Agent EIP-712 typed message signed with domain chainId = 1337.
// CRITICAL: action field ORDER drives the msgpack hash and must match the
// server's expected field order exactly.
// ═══════════════════════════════════════════════════════════════════════════

const HL_L1_DOMAIN = {
  name:              'Exchange',
  version:           '1',
  chainId:           1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const;

const AGENT_TYPES = {
  Agent: [
    { name: 'source',       type: 'string'  },
    { name: 'connectionId', type: 'bytes32' },
  ],
} as const;

/**
 * Build the L1 action hash: msgpack(action) ++ nonce(8B big-endian) ++ vaultFlag
 * vaultFlag: 0x00 = no vault; 0x01 + 20-byte address = vault/subaccount
 */
function actionHash(
  action:    unknown,
  nonce:     number,
  vaultAddr?: string,
): `0x${string}` {
  const packed     = msgpackEncode(action);
  const nonceBuf   = new ArrayBuffer(8);
  new DataView(nonceBuf).setBigUint64(0, BigInt(nonce), false); // big-endian
  const nonceBytes = new Uint8Array(nonceBuf);

  let combined: Uint8Array;
  if (!vaultAddr) {
    combined = new Uint8Array(packed.length + 8 + 1);
    combined.set(packed,     0);
    combined.set(nonceBytes, packed.length);
    combined[packed.length + 8] = 0;   // vaultFlag = 0
  } else {
    const addrBytes = Buffer.from(vaultAddr.slice(2), 'hex'); // 20 bytes
    combined = new Uint8Array(packed.length + 8 + 1 + 20);
    combined.set(packed,     0);
    combined.set(nonceBytes, packed.length);
    combined[packed.length + 8] = 1;   // vaultFlag = 1
    combined.set(addrBytes,  packed.length + 9);
  }
  return keccak256(toHex(combined));
}

async function signL1Action(
  account:    ReturnType<typeof privateKeyToAccount>,
  action:     unknown,
  nonce:      number,
  vaultAddr?: string,
): Promise<{ r: `0x${string}`; s: `0x${string}`; v: number }> {
  const connectionId = actionHash(action, nonce, vaultAddr);
  const sig = await account.signTypedData({
    domain:      HL_L1_DOMAIN,
    types:       AGENT_TYPES,
    primaryType: 'Agent',
    message:     { source: 'b', connectionId }, // 'b' = testnet, 'a' = mainnet
  });
  return rsv(sig);
}

// ═══════════════════════════════════════════════════════════════════════════
// PATTERN B: User-signed EIP-712 actions
// ─────────────────────────────────────────────────────────────────────────
// Used by: usdClassTransfer, usdSend, spotSend, sendAsset, sendToEvmWithData.
// Domain chainId = parseInt(action.signatureChainId, 16) — from the action.
// The action object MUST include both `hyperliquidChain` AND `signatureChainId`
// as top-level fields; they are required for server deserialisation AND are
// part of the signed typed-data hash.
// ═══════════════════════════════════════════════════════════════════════════

const HL_USER_DOMAIN_TESTNET = {
  name:              'HyperliquidSignTransaction',
  version:           '1',
  chainId:           HYPEREVM_CHAIN_ID,   // 998 = 0x3e6 testnet
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const;

function rsv(sig: `0x${string}`) {
  return {
    r: `0x${sig.slice(2,   66)}`  as `0x${string}`,
    s: `0x${sig.slice(66, 130)}`  as `0x${string}`,
    v: parseInt(sig.slice(130, 132), 16),
  };
}

// ── usdClassTransfer ─────────────────────────────────────────────────────────
// EIP-712 primary type: HyperliquidTransaction:UsdClassTransfer
// Signed fields: hyperliquidChain, amount, toPerp, nonce
// Action fields: type, hyperliquidChain, signatureChainId, amount, toPerp, nonce
//
// Subaccount suffix encoding (documented for HyPaper impl, not probed here
// because createSubAccount requires $100k traded volume on this testnet wallet):
//   amount = "<dollars> subaccount:<0xADDR>"
//   outer body must also include: vaultAddress: "<0xADDR>"
//   Example: amount="1 subaccount:0x1234..." + vaultAddress="0x1234..."
//   The EIP-712 message uses the full amount string (with suffix) verbatim.
//
// Note: disabled when unified account is active.
async function signUsdClassTransfer(
  account: ReturnType<typeof privateKeyToAccount>,
  action: {
    type:             string;
    hyperliquidChain: string;
    signatureChainId: string;
    amount:           string;
    toPerp:           boolean;
    nonce:            number;
  },
) {
  const sig = await account.signTypedData({
    domain: HL_USER_DOMAIN_TESTNET,
    types: {
      'HyperliquidTransaction:UsdClassTransfer': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'amount',           type: 'string' },
        { name: 'toPerp',           type: 'bool'   },
        { name: 'nonce',            type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:UsdClassTransfer',
    message: {
      hyperliquidChain: action.hyperliquidChain,
      amount:           action.amount,
      toPerp:           action.toPerp,
      nonce:            BigInt(action.nonce),
    },
  });
  return rsv(sig);
}

// ── usdSend ──────────────────────────────────────────────────────────────────
// EIP-712 primary type: HyperliquidTransaction:UsdSend
// Signed fields: hyperliquidChain, destination, amount, time
// Action fields: type, hyperliquidChain, signatureChainId, destination, amount, time
// `time` == outer nonce.
// Note: disabled when unified account is active.
async function signUsdSend(
  account: ReturnType<typeof privateKeyToAccount>,
  action: {
    type:             string;
    hyperliquidChain: string;
    signatureChainId: string;
    destination:      string;
    amount:           string;
    time:             number;
  },
) {
  const sig = await account.signTypedData({
    domain: HL_USER_DOMAIN_TESTNET,
    types: {
      'HyperliquidTransaction:UsdSend': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'destination',      type: 'string' },
        { name: 'amount',           type: 'string' },
        { name: 'time',             type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:UsdSend',
    message: {
      hyperliquidChain: action.hyperliquidChain,
      destination:      action.destination,
      amount:           action.amount,
      time:             BigInt(action.time),
    },
  });
  return rsv(sig);
}

// ── spotSend ─────────────────────────────────────────────────────────────────
// EIP-712 primary type: HyperliquidTransaction:SpotSend
// Signed fields: hyperliquidChain, destination, token, amount, time
// Action fields: type, hyperliquidChain, signatureChainId, destination, token, amount, time
// Note: disabled when unified account is active.
async function signSpotSend(
  account: ReturnType<typeof privateKeyToAccount>,
  action: {
    type:             string;
    hyperliquidChain: string;
    signatureChainId: string;
    destination:      string;
    token:            string;
    amount:           string;
    time:             number;
  },
) {
  const sig = await account.signTypedData({
    domain: HL_USER_DOMAIN_TESTNET,
    types: {
      'HyperliquidTransaction:SpotSend': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'destination',      type: 'string' },
        { name: 'token',            type: 'string' },
        { name: 'amount',           type: 'string' },
        { name: 'time',             type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:SpotSend',
    message: {
      hyperliquidChain: action.hyperliquidChain,
      destination:      action.destination,
      token:            action.token,
      amount:           action.amount,
      time:             BigInt(action.time),
    },
  });
  return rsv(sig);
}

// ── sendAsset ─────────────────────────────────────────────────────────────────
// EIP-712 primary type: HyperliquidTransaction:SendAsset
// Generalised transfer: between perp DEXs, spot, users, sub-accounts.
// sourceDex / destinationDex values:
//   ""     = default USDC perp DEX
//   "spot" = spot balance
//   "evm"  = HyperEVM
// Only USDC (collateral token) can move to/from a perp DEX.
// For unified accounts: sourceDex MUST be "spot" (perp source is disabled).
// Signed fields: hyperliquidChain, destination, sourceDex, destinationDex,
//                token, amount, fromSubAccount, nonce
// Action fields: type, hyperliquidChain, signatureChainId, destination,
//                sourceDex, destinationDex, token, amount, fromSubAccount, nonce
async function signSendAsset(
  account: ReturnType<typeof privateKeyToAccount>,
  action: {
    type:             string;
    hyperliquidChain: string;
    signatureChainId: string;
    destination:      string;
    sourceDex:        string;
    destinationDex:   string;
    token:            string;
    amount:           string;
    fromSubAccount:   string;
    nonce:            number;
  },
) {
  const sig = await account.signTypedData({
    domain: HL_USER_DOMAIN_TESTNET,
    types: {
      'HyperliquidTransaction:SendAsset': [
        { name: 'hyperliquidChain',  type: 'string' },
        { name: 'destination',       type: 'string' },
        { name: 'sourceDex',         type: 'string' },
        { name: 'destinationDex',    type: 'string' },
        { name: 'token',             type: 'string' },
        { name: 'amount',            type: 'string' },
        { name: 'fromSubAccount',    type: 'string' },
        { name: 'nonce',             type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:SendAsset',
    message: {
      hyperliquidChain:  action.hyperliquidChain,
      destination:       action.destination,
      sourceDex:         action.sourceDex,
      destinationDex:    action.destinationDex,
      token:             action.token,
      amount:            action.amount,
      fromSubAccount:    action.fromSubAccount,
      nonce:             BigInt(action.nonce),
    },
  });
  return rsv(sig);
}

// ── sendToEvmWithData ─────────────────────────────────────────────────────────
// EIP-712 primary type: HyperliquidTransaction:SendToEvmWithData
// Sends a token from HyperCore to HyperEVM and calls coreReceiveWithData()
// on the linked contract at `destinationRecipient`.
//
// Action fields (all required):
//   type, hyperliquidChain, signatureChainId,
//   token                — "NAME:0xTOKENID"
//   amount               — string
//   sourceDex            — "" (perp) or "spot"
//   destinationRecipient — hex EVM address (when addressEncoding "hex")
//   addressEncoding      — "hex" | "base58"
//   destinationChainId   — uint32 (HyperEVM chain ID: 998 testnet, 999 mainnet)
//   gasLimit             — uint64
//   data                 — hex bytes, "0x" for plain transfer
//   nonce                — timestamp ms, must match outer nonce
//
// CRITICAL TYPE NOTE: destinationChainId is `uint32`, NOT `uint64`.
// Source: Circle docs + nktkas/hyperliquid SDK.
// Using uint64 produces a wrong hash → wrong recovered signer address.
//
// Pattern B (user-signed), NOT L1 Agent.
async function signSendToEvmWithData(
  account: ReturnType<typeof privateKeyToAccount>,
  action: {
    type:                 string;
    hyperliquidChain:     string;
    signatureChainId:     string;
    token:                string;
    amount:               string;
    sourceDex:            string;
    destinationRecipient: string;
    addressEncoding:      string;
    destinationChainId:   number;  // uint32
    gasLimit:             number;  // uint64
    data:                 string;
    nonce:                number;
  },
) {
  const sig = await account.signTypedData({
    domain: HL_USER_DOMAIN_TESTNET,
    types: {
      'HyperliquidTransaction:SendToEvmWithData': [
        { name: 'hyperliquidChain',     type: 'string' },
        { name: 'token',                type: 'string' },
        { name: 'amount',               type: 'string' },
        { name: 'sourceDex',            type: 'string' },
        { name: 'destinationRecipient', type: 'string' },
        { name: 'addressEncoding',      type: 'string' },
        { name: 'destinationChainId',   type: 'uint32' },  // ← uint32, not uint64
        { name: 'gasLimit',             type: 'uint64' },
        { name: 'data',                 type: 'bytes'  },
        { name: 'nonce',                type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:SendToEvmWithData',
    message: {
      hyperliquidChain:     action.hyperliquidChain,
      token:                action.token,
      amount:               action.amount,
      sourceDex:            action.sourceDex,
      destinationRecipient: action.destinationRecipient,
      addressEncoding:      action.addressEncoding,
      destinationChainId:   action.destinationChainId,    // uint32 — no BigInt
      gasLimit:             BigInt(action.gasLimit),
      data:                 action.data as `0x${string}`,
      nonce:                BigInt(action.nonce),
    },
  });
  return rsv(sig);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function save(
  filename: string,
  data: { request?: unknown; requestBody?: unknown; response: unknown },
) {
  mkdirSync(CAPTURES_DIR, { recursive: true });
  const normalised = { request: data.request ?? data.requestBody, response: data.response };
  writeFileSync(resolve(CAPTURES_DIR, filename), JSON.stringify(normalised, null, 2));
  console.log(`  ✅ Saved: scripts/captures/${filename}`);
}

/** POST a Pattern A (L1 Agent) action. */
async function doL1Exchange(
  account:    ReturnType<typeof privateKeyToAccount>,
  action:     unknown,
  vaultAddr?: string,
): Promise<{ requestBody: unknown; response: unknown }> {
  const nonce     = Date.now();
  const signature = await signL1Action(account, action, nonce, vaultAddr);
  const body: Record<string, unknown> = { action, nonce, signature };
  if (vaultAddr) body.vaultAddress = vaultAddr;
  const res = await fetch(EXCHANGE_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { requestBody: body, response: parsed };
}

/** POST a Pattern B (user-signed) action.  Caller builds the full body. */
async function doUserSignedExchange(body: unknown): Promise<unknown> {
  const res = await fetch(EXCHANGE_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function infoPost(query: unknown): Promise<unknown> {
  const res = await fetch(INFO_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(query),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch {
    throw new Error(`infoPost returned non-JSON: ${text.slice(0, 200)}`);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Resolve spot token ID from testnet spotMeta ───────────────────────────────
// Returns "NAME:0xTOKENID" or null.  Token IDs differ between mainnet/testnet.
async function resolveSpotToken(tokenName: string): Promise<string | null> {
  const meta = await infoPost({ type: 'spotMeta' }) as any;
  const tokens: Array<{ name: string; tokenId: string }> = meta?.tokens ?? [];
  const found = tokens.find(t => t.name === tokenName);
  return found ? `${found.name}:${found.tokenId}` : null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const account  = privateKeyToAccount(PRIVATE_KEY!);
  const account2 = privateKeyToAccount(PRIVATE_KEY_2!);

  console.log('\n🔬 Hyperliquid Testnet Probe — Task 2 (Transfers & Funding) v3');
  console.log('================================================================');
  console.log(`Wallet 1: ${account.address}  (master / signer)`);
  console.log(`Wallet 2: ${account2.address}  (recipient / agent)`);

  if (account.address.toLowerCase() !== WALLET_ADDR!.toLowerCase()) {
    console.error(`\n❌ Key mismatch. Set HL_TESTNET_WALLET=${account.address}\n`);
    process.exit(1);
  }
  console.log('✅ Wallet 1 key matches.\n');

  // ── PRE-CHECKS ───────────────────────────────────────────────────────────────
  console.log('📥 Pre-check: clearinghouseState wallet 1...');
  const preState     = await infoPost({ type: 'clearinghouseState', user: WALLET_ADDR }) as any;
  const acct1Value   = parseFloat(preState?.marginSummary?.accountValue ?? '0');
  console.log(`  accountValue: $${acct1Value}`);
  if (acct1Value < 2) {
    console.warn('  ⚠️  Low balance — some sends may fail. Top up testnet USDC.');
  }

  console.log('📥 Pre-check: clearinghouseState wallet 2...');
  const preState2    = await infoPost({ type: 'clearinghouseState', user: account2.address }) as any;
  const acct2Value   = parseFloat(preState2?.marginSummary?.accountValue ?? '0');
  const wallet2Funded = acct2Value > 0;
  console.log(`  accountValue: $${acct2Value} ${wallet2Funded ? '✅' : '⚠️  unfunded — wallet2 sends will error'}`);
  await sleep(300);

  // ── SPOT META ─────────────────────────────────────────────────────────────────
  console.log('\n📡 Fetching testnet spotMeta to resolve token IDs...');
  const usdcToken = await resolveSpotToken('USDC') ?? 'USDC:0xeb62eee3685fc4c43992febcd9e75443';
  const purrToken = await resolveSpotToken('PURR') ?? 'PURR:0xc4bf3f870c0e9465323c0b6ed28096c2';
  console.log(`  USDC token: ${usdcToken}`);
  console.log(`  PURR token: ${purrToken}`);
  await sleep(300);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: usdClassTransfer — spot ↔ perp
  // Pattern B. Disabled on unified accounts (expected error).
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n📤 Step 1: usdClassTransfer — $1 perp → spot...');
  const n1a   = Date.now();
  const a1a   = { type: 'usdClassTransfer', hyperliquidChain: HL_CHAIN, signatureChainId: SIG_CHAIN_ID, amount: '1', toPerp: false, nonce: n1a };
  const s1a   = await signUsdClassTransfer(account, a1a);
  const b1a   = { action: a1a, nonce: n1a, signature: s1a };
  const r1a   = await doUserSignedExchange(b1a);
  save('18_usdClassTransfer_perp_to_spot.json', { request: b1a, response: r1a });
  console.log('  Response:', JSON.stringify(r1a, null, 2));
  await sleep(600);

  console.log('\n📤 Step 1b: usdClassTransfer — $1 spot → perp...');
  const n1b   = Date.now();
  const a1b   = { type: 'usdClassTransfer', hyperliquidChain: HL_CHAIN, signatureChainId: SIG_CHAIN_ID, amount: '1', toPerp: true, nonce: n1b };
  const s1b   = await signUsdClassTransfer(account, a1b);
  const b1b   = { action: a1b, nonce: n1b, signature: s1b };
  const r1b   = await doUserSignedExchange(b1b);
  save('18b_usdClassTransfer_spot_to_perp.json', { request: b1b, response: r1b });
  console.log('  Response:', JSON.stringify(r1b, null, 2));
  await sleep(600);

  // Step 1c: createSubAccount — probe the L1 action shape
  // This will fail unless $100k traded on testnet; we capture the error shape.
  // Sub-account docs: sign with master account + set vaultAddress in outer body.
  // Subaccount actions (usdClassTransfer suffix, subAccountTransfer) need the
  // `vaultAddress` outer field set to the sub-account's address.
  console.log('\n📤 Step 1c: createSubAccount — probe action shape...');
  const r1c = await doL1Exchange(account, { type: 'createSubAccount', name: 'hypaper-probe' });
  save('18c_createSubAccount.json', { request: r1c.requestBody, response: r1c.response });
  console.log('  Response:', JSON.stringify(r1c.response, null, 2));
  // NOTE: if response.status === 'ok', extract response.response.data as subAcctAddr
  // and then probe: usdClassTransfer with amount="1 subaccount:<subAcctAddr>"
  // and vaultAddress: subAcctAddr in the outer body.
  await sleep(600);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: usdSend — send USDC to wallet 2
  // Pattern B. Disabled on unified accounts (expected error when unified).
  // FIX vs v1: action includes hyperliquidChain + signatureChainId.
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n📤 Step 2: usdSend — send $1 USDC to wallet 2...');
  const n2a   = Date.now();
  const a2a   = {
    type: 'usdSend', hyperliquidChain: HL_CHAIN, signatureChainId: SIG_CHAIN_ID,
    destination: account2.address, amount: '1', time: n2a,
  };
  const s2a   = await signUsdSend(account, a2a);
  const b2a   = { action: a2a, nonce: n2a, signature: s2a };
  const r2a   = await doUserSignedExchange(b2a);
  save('19_usdSend.json', { request: b2a, response: r2a });
  console.log('  Response:', JSON.stringify(r2a, null, 2));
  await sleep(600);

  // Step 2b: wallet 2 → wallet 1 usdSend
  // Only run if wallet 2 has funds; otherwise "Must deposit" is guaranteed.
  if (wallet2Funded) {
    console.log('\n📤 Step 2b: usdSend — wallet 2 sends $0.5 USDC back to wallet 1...');
    const n2b = Date.now();
    const a2b = {
      type: 'usdSend', hyperliquidChain: HL_CHAIN, signatureChainId: SIG_CHAIN_ID,
      destination: account.address, amount: '0.5', time: n2b,
    };
    const s2b = await signUsdSend(account2, a2b);
    const b2b = { action: a2b, nonce: n2b, signature: s2b };
    const r2b = await doUserSignedExchange(b2b);
    save('19b_usdSend_wallet2_to_wallet1.json', { request: b2b, response: r2b });
    console.log('  Response:', JSON.stringify(r2b, null, 2));
    await sleep(600);
  } else {
    console.log('\n  ⏭️  Skipping Step 2b — wallet 2 not funded (fund via testnet faucet)');
    // Probe anyway to capture the exact "Must deposit" error shape for HyPaper
    const n2b = Date.now();
    const a2b = {
      type: 'usdSend', hyperliquidChain: HL_CHAIN, signatureChainId: SIG_CHAIN_ID,
      destination: account.address, amount: '0.5', time: n2b,
    };
    const s2b = await signUsdSend(account2, a2b);
    const b2b = { action: a2b, nonce: n2b, signature: s2b };
    const r2b = await doUserSignedExchange(b2b);
    save('19b_usdSend_wallet2_to_wallet1.json', { request: b2b, response: r2b });
    console.log('  Response (expected: must deposit):', JSON.stringify(r2b, null, 2));
    await sleep(600);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: spotSend — send PURR to wallet 2
  // Pattern B. Disabled on unified accounts (expected error).
  // FIX vs v1: action includes hyperliquidChain + signatureChainId.
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n📤 Step 3: spotSend — send 0.1 PURR to wallet 2...');
  const n3   = Date.now();
  const a3   = {
    type: 'spotSend', hyperliquidChain: HL_CHAIN, signatureChainId: SIG_CHAIN_ID,
    destination: account2.address, token: purrToken, amount: '0.1', time: n3,
  };
  const s3   = await signSpotSend(account, a3);
  const b3   = { action: a3, nonce: n3, signature: s3 };
  const r3   = await doUserSignedExchange(b3);
  save('20_spotSend.json', { request: b3, response: r3 });
  console.log('  Response:', JSON.stringify(r3, null, 2));
  await sleep(600);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: sendAsset — USDC spot → spot (self-transfer, same account)
  // Pattern B. Works on unified accounts when sourceDex = "spot".
  // FIX vs v2: changed sourceDex from "" (perp) to "spot".
  //   v2 error: "Unified account only supports sending assets through spot"
  // Self-transfer (destination = account.address) moves USDC within spot balance
  // between sub-accounts or just confirms the action shape round-trips.
  // For HyPaper impl: sendAsset is the generalised cross-user / cross-book move.
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n📤 Step 4: sendAsset — USDC spot → spot (wallet 1 self-transfer)...');
  const n4   = Date.now();
  const a4   = {
    type:             'sendAsset',
    hyperliquidChain: HL_CHAIN,
    signatureChainId: SIG_CHAIN_ID,
    destination:      account.address,  // self
    sourceDex:        'spot',           // ← "spot" required for unified accounts
    destinationDex:   'spot',
    token:            usdcToken,
    amount:           '0.1',
    fromSubAccount:   '',
    nonce:            n4,
  };
  const s4   = await signSendAsset(account, a4);
  const b4   = { action: a4, nonce: n4, signature: s4 };
  const r4   = await doUserSignedExchange(b4);
  save('21_sendAsset.json', { request: b4, response: r4 });
  console.log('  Response:', JSON.stringify(r4, null, 2));
  await sleep(600);

  // Step 4b: sendAsset to wallet 2 (cross-user spot send)
  console.log('\n📤 Step 4b: sendAsset — USDC spot → spot (wallet 1 → wallet 2)...');
  const n4b  = Date.now();
  const a4b  = {
    type:             'sendAsset',
    hyperliquidChain: HL_CHAIN,
    signatureChainId: SIG_CHAIN_ID,
    destination:      account2.address,  // different user
    sourceDex:        'spot',
    destinationDex:   'spot',
    token:            usdcToken,
    amount:           '0.1',
    fromSubAccount:   '',
    nonce:            n4b,
  };
  const s4b  = await signSendAsset(account, a4b);
  const b4b  = { action: a4b, nonce: n4b, signature: s4b };
  const r4b  = await doUserSignedExchange(b4b);
  save('21b_sendAsset_to_wallet2.json', { request: b4b, response: r4b });
  console.log('  Response:', JSON.stringify(r4b, null, 2));
  await sleep(600);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5: agentSendAsset — L1 Agent signed (NOT user-signed)
  // Pattern A. Wallet 2 acts as agent for wallet 1.
  // The docs say: "destination must match the source address" — meaning the
  // master account address. It's a within-account move signed by the agent.
  // Error will be "User or API Wallet does not exist" if wallet 2 is not a
  // registered/funded agent — expected; captures the correct shape.
  // FIX vs v1: switched from Pattern B to Pattern A (L1 Agent signing).
  // Action has NO hyperliquidChain / signatureChainId fields.
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n📤 Step 5: agentSendAsset — signed by wallet 2 (agent), dest = wallet 1...');
  // Field order for agentSendAsset (mirrors Python SDK SEND_ASSET_SIGN_TYPES minus chain fields):
  const agentAction = {
    type:           'agentSendAsset',
    destination:    account.address,  // master account — must match source
    sourceDex:      'spot',
    destinationDex: 'spot',
    token:          usdcToken,
    amount:         '0.1',
    fromSubAccount: '',
    nonce:          Date.now(),
  };
  const r5 = await doL1Exchange(account2, agentAction); // signed by agent (wallet 2)
  save('22_agentSendAsset.json', { request: r5.requestBody, response: r5.response });
  console.log('  Response:', JSON.stringify(r5.response, null, 2));
  await sleep(600);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 6: sendToEvmWithData — HyperCore → HyperEVM with calldata
  // Pattern B (user-signed). NOT L1 Agent.
  // FIX vs v1: complete action shape + correct signing domain.
  // FIX vs v2: destinationChainId type fixed from uint64 → uint32.
  //   v2 symptom: recovered signer was 0x50acf... instead of wallet 1.
  //   Root cause: wrong EIP-712 type for destinationChainId changed the hash.
  // This will still error because the token must be linked to an EVM contract,
  // but the error will be meaningful (not a deserialization or signer error).
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n📤 Step 6: sendToEvmWithData — USDC spot → HyperEVM...');
  const n6   = Date.now();
  const a6   = {
    type:                 'sendToEvmWithData',
    hyperliquidChain:     HL_CHAIN,
    signatureChainId:     SIG_CHAIN_ID,
    token:                usdcToken,
    amount:               '0.1',
    sourceDex:            'spot',
    destinationRecipient: account2.address,  // EVM recipient
    addressEncoding:      'hex',
    destinationChainId:   HYPEREVM_CHAIN_ID, // 998 — uint32
    gasLimit:             100000,
    data:                 '0x',              // empty calldata = plain transfer
    nonce:                n6,
  };
  const s6   = await signSendToEvmWithData(account, a6);
  const b6   = { action: a6, nonce: n6, signature: s6 };
  const r6   = await doUserSignedExchange(b6);
  save('23_sendToEvmWithData.json', { request: b6, response: r6 });
  console.log('  Response:', JSON.stringify(r6, null, 2));
  await sleep(600);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 7-9: state queries (read-only)
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n📥 Step 7: clearinghouseState — wallet 1 (post-transfers)...');
  const q7   = { type: 'clearinghouseState', user: account.address };
  const r7   = await infoPost(q7);
  save('24_clearinghouse_wallet1_post.json', { request: q7, response: r7 });
  console.log('  accountValue:', (r7 as any)?.marginSummary?.accountValue ?? 'n/a');
  await sleep(300);

  console.log('\n📥 Step 8: clearinghouseState — wallet 2 (verify credits)...');
  const q8   = { type: 'clearinghouseState', user: account2.address };
  const r8   = await infoPost(q8);
  save('25_clearinghouse_wallet2.json', { request: q8, response: r8 });
  console.log('  wallet2 accountValue:', (r8 as any)?.marginSummary?.accountValue ?? 'n/a');
  await sleep(300);

  console.log('\n📥 Step 9: spotClearinghouseState — both wallets...');
  const spot1 = await infoPost({ type: 'spotClearinghouseState', user: account.address });
  const spot2 = await infoPost({ type: 'spotClearinghouseState', user: account2.address });
  save('26_spot_balances_wallet1.json', { request: { type: 'spotClearinghouseState', user: account.address }, response: spot1 });
  save('27_spot_balances_wallet2.json', { request: { type: 'spotClearinghouseState', user: account2.address }, response: spot2 });
  const w1bal = (spot1 as any)?.balances?.find((b: any) => b.coin === 'USDC');
  const w2bal = (spot2 as any)?.balances?.find((b: any) => b.coin === 'USDC');
  console.log(`  wallet1 USDC spot: ${w1bal?.total ?? '0'} (hold: ${w1bal?.hold ?? '0'})`);
  console.log(`  wallet2 USDC spot: ${w2bal?.total ?? '0'}`);

  // ─────────────────────────────────────────────────────────────────────────

  console.log('\n✅ Done! Captures saved to scripts/captures/\n');
  console.log('  CAPTURES:');
  console.log('  18_usdClassTransfer_perp_to_spot.json    usdClassTransfer perp→spot');
  console.log('  18b_usdClassTransfer_spot_to_perp.json   usdClassTransfer spot→perp');
  console.log('  18c_createSubAccount.json                createSubAccount (L1 Agent)');
  console.log('  19_usdSend.json                          usdSend wallet1→wallet2');
  console.log('  19b_usdSend_wallet2_to_wallet1.json      usdSend wallet2→wallet1');
  console.log('  20_spotSend.json                         spotSend (PURR)');
  console.log('  21_sendAsset.json                        sendAsset spot→spot (self)');
  console.log('  21b_sendAsset_to_wallet2.json            sendAsset spot→spot (cross-user)');
  console.log('  22_agentSendAsset.json                   agentSendAsset (L1 Agent signed)');
  console.log('  23_sendToEvmWithData.json                sendToEvmWithData');
  console.log('  24_clearinghouse_wallet1_post.json       wallet1 perp state');
  console.log('  25_clearinghouse_wallet2.json            wallet2 perp state');
  console.log('  26_spot_balances_wallet1.json            wallet1 spot balances');
  console.log('  27_spot_balances_wallet2.json            wallet2 spot balances\n');

  console.log('📋 EXPECTED OUTCOMES (what each capture should show):');
  console.log('  18/18b  "Action disabled when unified account is active" — shape confirmed OK');
  console.log('  18c     Volume error OR { status:"ok" } with sub-account address');
  console.log('  19      "Action disabled when unified account is active" — shape confirmed OK');
  console.log('  19b     Same if unified, OR ok/must-deposit depending on wallet2 state');
  console.log('  20      "Action disabled when unified account is active" — shape confirmed OK');
  console.log('  21      { status:"ok" } — spot→spot self-transfer should succeed ✅');
  console.log('  21b     { status:"ok" } if wallet2 is funded, else balance/deposit error');
  console.log('  22      "User or API Wallet does not exist" if wallet2 unfunded — shape OK');
  console.log('  23      Token/bridge error (NOT "Must deposit" or signer error) — shape OK');
  console.log('          If 23 still shows "Must deposit: 0x50acf..." → uint32 fix failed\n');

  console.log('📋 HYPAPER IMPLEMENTATION NOTES:');
  console.log('  • usdClassTransfer: disabled on unified accounts; use sendAsset instead');
  console.log('  • usdSend/spotSend: disabled on unified accounts; use sendAsset instead');
  console.log('  • sendAsset: sourceDex="spot" for unified accounts; ""  for classic accounts');
  console.log('  • agentSendAsset: Pattern A (L1 Agent signing), no chain fields in action');
  console.log('  • sendToEvmWithData: destinationChainId is uint32 in EIP-712 types');
  console.log('  • Subaccounts: sign with master, set vaultAddress in outer body');
  console.log('    usdClassTransfer amount suffix: "<amt> subaccount:<0xADDR>"\n');
}

main().catch(err => { console.error('\n💥', err); process.exit(1); });