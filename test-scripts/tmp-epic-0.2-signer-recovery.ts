/**
 * TMP verification — Epic 0.2 (user-signed action signature recovery).
 *
 * Proves, against a running local HyPaper:
 *   1. A user-signed action (usdClassTransfer) signed with HL's canonical
 *      EIP-712 scheme is recovered to the CORRECT signer. Proof: HyPaper
 *      calls ensureAccount(recoveredWallet) before dispatch, so the account
 *      appears in Redis under the signer's EXACT address. A wrong scheme
 *      would recover a phantom address → the signer's key would be absent.
 *   2. An L1 action (cancel) still recovers correctly with the mainnet
 *      source fix ("a"). Same Redis-key proof.
 *   3. ethers handles HL's colon-bearing primaryType ("HyperliquidTransaction:…").
 *
 * Each test uses a FRESH random wallet so its account can't pre-exist.
 *
 * Usage: npx tsx test-scripts/tmp-epic-0.2-signer-recovery.ts [baseUrl]
 * Throwaway — delete after Epic 0.2 sign-off.
 */

import { ethers } from 'ethers';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { execSync } from 'node:child_process';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const REDIS_CONTAINER = 'hypaper-redis-1';

function redisExists(key: string): boolean {
  const out = execSync(`docker exec ${REDIS_CONTAINER} redis-cli EXISTS ${JSON.stringify(key)}`)
    .toString().trim();
  return out === '1';
}

async function postExchange(body: object): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}/exchange`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { __raw: text }; }
  return { status: r.status, json };
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
  ok ? pass++ : fail++;
}

// ── user-signed: build EIP-712 the way HL's Python SDK does ──────────────
async function signUserSigned(wallet: ethers.Wallet, action: Record<string, unknown>, fields: { name: string; type: string }[], primaryType: string) {
  const chainId = parseInt(action.signatureChainId as string, 16);
  const domain = { name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: '0x0000000000000000000000000000000000000000' };
  const types = { [primaryType]: fields };
  const sigHex = await wallet.signTypedData(domain, types, action);
  const sig = ethers.Signature.from(sigHex);
  return { r: sig.r, s: sig.s, v: sig.v };
}

// ── L1: connectionId = keccak(msgpack(action) ++ nonce_be8 ++ 0x00) ──────
async function signL1(wallet: ethers.Wallet, action: unknown, nonce: number) {
  const packed = msgpackEncode(action);
  const buf = new Uint8Array(packed.length + 8 + 1);
  buf.set(packed, 0);
  new DataView(buf.buffer).setBigUint64(packed.length, BigInt(nonce), false);
  buf[packed.length + 8] = 0; // vaultFlag = 0
  const connectionId = ethers.keccak256(buf);
  const domain = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' };
  const types = { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] };
  const sigHex = await wallet.signTypedData(domain, types, { source: 'a', connectionId });
  const sig = ethers.Signature.from(sigHex);
  return { r: sig.r, s: sig.s, v: sig.v };
}

(async () => {
  console.log(`HyPaper: ${BASE}\n`);

  // 1. user-signed usdClassTransfer
  {
    const w = ethers.Wallet.createRandom();
    const addr = w.address.toLowerCase();
    const nonce = Date.now();
    const action = { type: 'usdClassTransfer', hyperliquidChain: 'Mainnet', signatureChainId: '0x66eee', amount: '10', toPerp: true, nonce };
    const fields = [
      { name: 'hyperliquidChain', type: 'string' }, { name: 'amount', type: 'string' },
      { name: 'toPerp', type: 'bool' }, { name: 'nonce', type: 'uint64' },
    ];
    const existedBefore = redisExists(`user:${addr}:account`);
    const sig = await signUserSigned(w as ethers.Wallet, action, fields, 'HyperliquidTransaction:UsdClassTransfer');
    const { json } = await postExchange({ action, nonce, signature: sig });
    const accountCreated = redisExists(`user:${addr}:account`);
    // Handler not implemented yet (Phase 2) → recovery succeeded if we get
    // "Unsupported action type", NOT "Signature recovery failed".
    const recovered = typeof json.response === 'string' && json.response.includes('Unsupported action type');
    check('usdClassTransfer recovered to correct signer',
      !existedBefore && accountCreated && recovered,
      `account ${addr} created=${accountCreated}, resp="${json.response}"`);
  }

  // 2. L1 cancel (mainnet source "a")
  {
    const w = ethers.Wallet.createRandom();
    const addr = w.address.toLowerCase();
    const nonce = Date.now() + 1;
    const action = { type: 'cancel', cancels: [{ a: 0, o: 999999999 }] };
    const existedBefore = redisExists(`user:${addr}:account`);
    const sig = await signL1(w as ethers.Wallet, action, nonce);
    const { json } = await postExchange({ action, nonce, signature: sig });
    const accountCreated = redisExists(`user:${addr}:account`);
    // cancel of a nonexistent oid → status ok, statuses:[{error:...}].
    const dispatched = json.status === 'ok' || (typeof json.response === 'string' && !json.response.includes('recovery failed'));
    check('L1 cancel recovered to correct signer (source "a")',
      !existedBefore && accountCreated && dispatched,
      `account ${addr} created=${accountCreated}, status=${json.status}`);
  }

  // 3. negative: tampered signature → recovery yields a DIFFERENT address,
  //    so the original signer's account must NOT be created.
  {
    const w = ethers.Wallet.createRandom();
    const addr = w.address.toLowerCase();
    const nonce = Date.now() + 2;
    const action = { type: 'usdClassTransfer', hyperliquidChain: 'Mainnet', signatureChainId: '0x66eee', amount: '5', toPerp: false, nonce };
    const fields = [
      { name: 'hyperliquidChain', type: 'string' }, { name: 'amount', type: 'string' },
      { name: 'toPerp', type: 'bool' }, { name: 'nonce', type: 'uint64' },
    ];
    const sig = await signUserSigned(w as ethers.Wallet, action, fields, 'HyperliquidTransaction:UsdClassTransfer');
    // Tamper the amount AFTER signing → recovers a phantom, not `addr`.
    const tampered = { ...action, amount: '999999' };
    await postExchange({ action: tampered, nonce, signature: sig });
    const signerCreated = redisExists(`user:${addr}:account`);
    check('tampered action does NOT create signer account',
      !signerCreated,
      `signer ${addr} account exists=${signerCreated} (should be false)`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
