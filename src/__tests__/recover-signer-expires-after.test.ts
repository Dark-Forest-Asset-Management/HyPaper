import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/trailing/trailing-stop-requests.json'), 'utf8'),
);

// The captured requests were signed against HL TESTNET (phantom-agent
// source "b"). recoverHlSigner derives the source from HL_API_URL.
vi.mock('../config.js', () => ({
  config: { HL_API_URL: 'https://api.hyperliquid-testnet.xyz', LOG_LEVEL: 'silent' },
}));

const { recoverHlSigner } = await import('../api/middleware/recoverHlSigner.js');

/** The browser DevTools JSON is key-SORTED; HL signs msgpack in struct order. */
function inSigningOrder(a: Record<string, any>) {
  return {
    type: a.type, asset: a.asset, isBuy: a.isBuy, sz: a.sz,
    reduceOnly: a.reduceOnly, retracement: a.retracement, activationPx: a.activationPx,
  };
}

describe('recoverHlSigner — expiresAfter is part of the signed hash (D3)', () => {
  it('recovers the UI agent wallet only when expiresAfter is included', () => {
    for (const cap of fixtures.uiCaptures) {
      const withExpiry = recoverHlSigner(
        inSigningOrder(cap.action), cap.nonce, cap.signature, undefined, cap.expiresAfter,
      );
      expect(withExpiry).toBe(fixtures.agentWallet);

      // Same request hashed WITHOUT the suffix (the old behaviour) → phantom signer.
      const without = recoverHlSigner(inSigningOrder(cap.action), cap.nonce, cap.signature);
      expect(without).not.toBe(fixtures.agentWallet);
    }
  });

  it('the two UI captures recover the SAME wallet (consistency, not a lucky address)', () => {
    const addrs = fixtures.uiCaptures.map((c: any) =>
      recoverHlSigner(inSigningOrder(c.action), c.nonce, c.signature, undefined, c.expiresAfter));
    expect(new Set(addrs).size).toBe(1);
  });

  it('requests signed WITHOUT expiresAfter (probe / slushy) still recover correctly', () => {
    for (const cap of fixtures.probeCaptures) {
      const addr = recoverHlSigner(cap.action, cap.nonce, cap.signature);
      expect(addr).toBe(fixtures.mainWallet);
    }
  });

  it('a request signed without expiresAfter but sent with one no longer recovers the signer', () => {
    const cap = fixtures.probeCaptures[0];
    const addr = recoverHlSigner(cap.action, cap.nonce, cap.signature, undefined, Date.now() + 60_000);
    expect(addr).not.toBe(fixtures.mainWallet);
  });
});
