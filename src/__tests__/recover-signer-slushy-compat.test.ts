/**
 * Regression guard for the D3 change (`expiresAfter` is now part of the signed hash):
 * requests that DON'T carry expiresAfter — which is everything slushy.trade sends today —
 * must keep recovering the SAME wallet.
 *
 * Independent signer on purpose: slushy signs with the `hyperliquid` SDK's `signL1Action`
 * (src/api/hlSign.ts → nomeidaSignL1Action(wallet, action, vault|null, nonce, signForMainnet()),
 * which is false in paper mode — the only mode that reaches HyPaper),
 * which has no expiresAfter parameter at all). That same SDK is a HyPaper dependency, so these
 * tests sign with it and verify through HyPaper's real /exchange route — not through our own
 * hashing code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { Wallet } from 'ethers';
import { signL1Action } from 'hyperliquid';
import { RedisMock } from './helpers/redis-mock.js';

const redisMock = new RedisMock();
vi.mock('../store/redis.js', () => ({ redis: redisMock }));
vi.mock('../api/middleware/auth.js', () => ({ ensureAccount: vi.fn(async () => {}) }));
const placeOrders = vi.fn(async (..._a: unknown[]) => [{ resting: { oid: 1 } }]);
const cancelOrders = vi.fn(async (..._a: unknown[]) => ['success']);
vi.mock('../engine/order.js', () => ({
  placeOrders, cancelOrders,
  cancelByCloid: vi.fn(async () => []), updateLeverage: vi.fn(async () => {}),
}));
const placeTrailingStop = vi.fn(async (..._a: unknown[]) => ({ oid: 7 }));
vi.mock('../engine/trailingStop.js', () => ({ placeTrailingStop }));
vi.mock('../store/pg-sink.js', () => ({
  upsertUser: vi.fn(), updateUserBalance: vi.fn(), recordLedgerUpdate: vi.fn(), recordFunding: vi.fn(),
}));
// HyPaper accepts only the testnet phantom-agent source "b" whatever HL_API_URL is (C1),
// so the mainnet URL here proves the source no longer follows the endpoint.
vi.mock('../config.js', () => ({
  config: { HL_API_URL: 'https://api.hyperliquid.xyz', DEFAULT_BALANCE: '10000', LOG_LEVEL: 'silent' },
}));

const { exchangeRouter } = await import('../api/routes/exchange.js');
const { recoverHlSigner } = await import('../api/middleware/recoverHlSigner.js');
const { KEYS } = await import('../store/keys.js');
const app = new Hono();
app.route('/exchange', exchangeRouter);

const post = (body: unknown) =>
  app.request('/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const wallet = Wallet.createRandom();
const VAULT = '0x1111111111111111111111111111111111111111';
let nonce = Date.now();

/** Body exactly as slushy builds it: { action, nonce, signature } — vaultAddress only when set, NO expiresAfter. */
async function slushyBody(action: unknown, vault: string | null = null) {
  const n = ++nonce;
  // ethers ships separate ESM/CJS typings; the SDK is typed against the CJS one.
  const sig = await signL1Action(wallet as unknown as Parameters<typeof signL1Action>[0], action, vault, n, false);
  return { action, nonce: n, signature: sig, ...(vault ? { vaultAddress: vault } : {}) };
}

const orderAction = {
  type: 'order',
  orders: [{ a: 0, b: true, p: '100000', s: '0.001', r: false, t: { limit: { tif: 'Gtc' } } }],
  grouping: 'na',
};

describe('requests WITHOUT expiresAfter (what slushy sends today) still recover the signer after D3', () => {
  beforeEach(async () => {
    redisMock.flushall(); placeOrders.mockClear(); cancelOrders.mockClear();
    // vaultAddress is honoured only for the signer's own sub-account (HP-02).
    await redisMock.set(KEYS.SUBACCOUNT_MASTER(VAULT.toLowerCase()), wallet.address.toLowerCase());
  });

  it('order — acts as the signer', async () => {
    const res = await post(await slushyBody(orderAction));
    expect(res.status).toBe(200);
    expect(placeOrders.mock.calls[0][0]).toBe(wallet.address.toLowerCase());
  });

  it('cancel — acts as the signer', async () => {
    const res = await post(await slushyBody({ type: 'cancel', cancels: [{ a: 0, o: 12345 }] }));
    expect(res.status).toBe(200);
    expect(cancelOrders.mock.calls[0][0]).toBe(wallet.address.toLowerCase());
  });

  it('sub-account / vault trading (vaultAddress in body + in the hash) still recovers the signer', async () => {
    const body = await slushyBody(orderAction, VAULT);
    expect(recoverHlSigner(body.action, body.nonce, body.signature, VAULT)).toBe(wallet.address.toLowerCase());
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(placeOrders.mock.calls[0][0]).toBe(VAULT); // acts on the vault, signed by the master
  });

  it('a future slushy trailingStop (SDK-signed, canonical key order) recovers the signer through the route', async () => {
    const action = {
      type: 'trailingStop', asset: 3, isBuy: false, sz: '0.00015', reduceOnly: true,
      retracement: { pct: '5.0000%' }, activationPx: null,
    };
    const body = await slushyBody(action);
    expect(recoverHlSigner(body.action, body.nonce, body.signature)).toBe(wallet.address.toLowerCase());
    expect((await post(body)).status).toBe(200);
  });

  it('a trailing stop with a vaultAddress (sub-account) is placed on the VAULT\'s account but signed by the master', async () => {
    const action = {
      type: 'trailingStop', asset: 3, isBuy: false, sz: '0.00015', reduceOnly: true,
      retracement: { px: '3000' }, activationPx: null,
    };
    placeTrailingStop.mockClear();
    const body = await slushyBody(action, VAULT);
    expect(recoverHlSigner(body.action, body.nonce, body.signature, VAULT)).toBe(wallet.address.toLowerCase());
    expect((await post(body)).status).toBe(200);
    expect(placeTrailingStop.mock.calls[0][0]).toBe(VAULT);          // effective account = the vault
    expect(placeTrailingStop.mock.calls[0][0]).not.toBe(wallet.address.toLowerCase());
  });

  it('hashing is unchanged for these requests: omitting expiresAfter reproduces the pre-D3 connectionId bytes', async () => {
    const { buildConnectionId } = await import('../api/middleware/recoverHlSigner.js');
    const { encode } = await import('@msgpack/msgpack');
    const { keccak256 } = await import('ethers');
    const n = 1_700_000_000_000;
    const packed = encode(orderAction);
    const legacy = new Uint8Array(packed.length + 9);       // the pre-D3 layout: msgpack ‖ nonce(8) ‖ vaultFlag(0)
    legacy.set(packed);
    new DataView(legacy.buffer).setBigUint64(packed.length, BigInt(n), false);
    expect(buildConnectionId(orderAction, n)).toBe(keccak256(legacy));
  });

  it('and WITH expiresAfter the hash genuinely differs (so the fix is active, not a no-op)', async () => {
    const { buildConnectionId } = await import('../api/middleware/recoverHlSigner.js');
    expect(buildConnectionId(orderAction, 1, undefined, 1_800_000_000_000)).not.toBe(buildConnectionId(orderAction, 1));
  });
});
