/**
 * The paper signing domain is a security boundary (2026-10-13 review, C1):
 * HyPaper must accept ONLY HL's testnet domain so a paper signature can
 * never be replayed on mainnet. These tests pin that in both directions —
 * a testnet-domain signature recovers to the signer; the same action
 * signed with the MAINNET domain does NOT recover to the signer (so a
 * mainnet signature forwarded here acts as a phantom address), and a
 * user-signed action with hyperliquidChain 'Mainnet' is refused outright.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { recoverHlSigner, PAPER_SOURCE } from '../api/middleware/recoverHlSigner.js';
import { recoverUserSignedAction, PAPER_HYPERLIQUID_CHAIN } from '../api/middleware/recoverUserSignedAction.js';

const wallet = ethers.Wallet.createRandom();
const L1_DOMAIN = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' };
const AGENT_TYPES = { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] };

function connectionId(action: unknown, nonce: number): string {
  const packed = msgpackEncode(action);
  const nonceBuf = new Uint8Array(8);
  new DataView(nonceBuf.buffer).setBigUint64(0, BigInt(nonce), false);
  const combined = new Uint8Array(packed.length + 9);
  combined.set(packed, 0);
  combined.set(nonceBuf, packed.length);
  combined[packed.length + 8] = 0;
  return ethers.keccak256(combined);
}

function split(sigHex: string) {
  const raw = sigHex.slice(2);
  return { r: '0x' + raw.slice(0, 64), s: '0x' + raw.slice(64, 128), v: parseInt(raw.slice(128, 130), 16) };
}

describe('paper signing domain', () => {
  const action = { type: 'cancel', cancels: [{ a: 0, o: 1 }] };
  const nonce = 1_700_000_000_000;

  it('is pinned to the HL testnet domain', () => {
    expect(PAPER_SOURCE).toBe('b');
    expect(PAPER_HYPERLIQUID_CHAIN).toBe('Testnet');
  });

  it('recovers the signer from a testnet-domain L1 signature', async () => {
    const sig = await wallet.signTypedData(L1_DOMAIN, AGENT_TYPES, { source: 'b', connectionId: connectionId(action, nonce) });
    expect(recoverHlSigner(action, nonce, split(sig))).toBe(wallet.address.toLowerCase());
  });

  it('does NOT recover the signer from a MAINNET-domain L1 signature (a forwarded mainnet signature is a phantom here, and vice versa)', async () => {
    const sig = await wallet.signTypedData(L1_DOMAIN, AGENT_TYPES, { source: 'a', connectionId: connectionId(action, nonce) });
    expect(recoverHlSigner(action, nonce, split(sig))).not.toBe(wallet.address.toLowerCase());
  });

  it('refuses a user-signed action carrying hyperliquidChain Mainnet', async () => {
    const domain = { name: 'HyperliquidSignTransaction', version: '1', chainId: 421614, verifyingContract: '0x0000000000000000000000000000000000000000' };
    const types = { 'HyperliquidTransaction:UsdSend': [
      { name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' },
      { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' },
    ] };
    const base = { destination: wallet.address, amount: '1', time: nonce };
    const mainnet = { hyperliquidChain: 'Mainnet', ...base };
    const sigM = await wallet.signTypedData(domain, types, mainnet);
    expect(() => recoverUserSignedAction({ type: 'usdSend', signatureChainId: '0x66eee', ...mainnet }, split(sigM))).toThrow(/Testnet/);

    const testnet = { hyperliquidChain: 'Testnet', ...base };
    const sigT = await wallet.signTypedData(domain, types, testnet);
    expect(recoverUserSignedAction({ type: 'usdSend', signatureChainId: '0x66eee', ...testnet }, split(sigT))).toBe(wallet.address.toLowerCase());
  });
});
