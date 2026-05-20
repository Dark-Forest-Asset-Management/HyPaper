/**
 * Recover the signer wallet from an HL-style signed /exchange action.
 * Mirrors slushy/src/api/hlSign.ts in reverse — same EIP-712 domain,
 * same Agent type, same connectionId hashing — so any signature
 * produced by slushy verifies cleanly.
 *
 * Why this exists:
 *   HL prod's /exchange schema is `{ action, nonce, signature,
 *   vaultAddress?, expiresAfter? }` — NO `wallet` field. HyPaper
 *   used to require `wallet`, which made it impossible for slushy
 *   to use a single body shape across paper and live modes (HL
 *   rejected the extra field with 422). This module brings HyPaper
 *   in line with HL's API: the signer is recovered from the
 *   signature, not trusted from a body field.
 *
 * Reference:
 *   - HL Python SDK: hyperliquid/utils/signing.py#sign_l1_action
 *   - slushy/src/api/hlSign.ts#signL1Action (the inverse)
 */

import { ethers } from 'ethers';
import { encode as msgpackEncode } from '@msgpack/msgpack';

// HL's L1-action EIP-712 domain. Identical to what slushy signs
// against. chainId 1337 is HL's hardcoded value for L1 actions.
const HL_EIP712_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const;

const AGENT_TYPES: Record<string, ethers.TypedDataField[]> = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
};

interface HlSignature {
  r: string;
  s: string;
  v: number;
}

/** Build the connectionId — keccak256(msgpack(action) + nonce_be8 +
 *  vaultFlag + vaultAddrBytes). Must byte-match slushy's
 *  actionConnectionId. */
function buildConnectionId(action: unknown, nonce: number, vaultAddress?: string): string {
  const packed = msgpackEncode(action);
  const nonceBuf = new ArrayBuffer(8);
  new DataView(nonceBuf).setBigUint64(0, BigInt(nonce), false);
  const nonceBytes = new Uint8Array(nonceBuf);
  const vaultFlag = vaultAddress ? new Uint8Array([1]) : new Uint8Array([0]);
  const vaultBytes = vaultAddress ? hexToBytes(vaultAddress) : new Uint8Array(0);
  const combined = new Uint8Array(packed.length + nonceBytes.length + vaultFlag.length + vaultBytes.length);
  combined.set(packed, 0);
  combined.set(nonceBytes, packed.length);
  combined.set(vaultFlag, packed.length + nonceBytes.length);
  combined.set(vaultBytes, packed.length + nonceBytes.length + vaultFlag.length);
  return ethers.keccak256(combined);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Recover the signer address from an HL-style signed action.
 *  Returns the lowercased 0x address. Throws if the signature is
 *  malformed or doesn't recover to a valid address. */
export function recoverHlSigner(
  action: unknown,
  nonce: number,
  signature: HlSignature,
  vaultAddress?: string,
): string {
  const connectionId = buildConnectionId(action, nonce, vaultAddress);
  const message = { source: 'a', connectionId };
  // Reassemble the 65-byte signature from { r, s, v } parts.
  const r = signature.r.startsWith('0x') ? signature.r.slice(2) : signature.r;
  const s = signature.s.startsWith('0x') ? signature.s.slice(2) : signature.s;
  const v = signature.v.toString(16).padStart(2, '0');
  const sigHex = `0x${r}${s}${v}`;
  const recovered = ethers.verifyTypedData(HL_EIP712_DOMAIN, AGENT_TYPES, message, sigHex);
  return recovered.toLowerCase();
}
