import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RedisMock } from './helpers/redis-mock.js';

const fixtures = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/trailing/trailing-stop-requests.json'), 'utf8'),
);

const redisMock = new RedisMock();
vi.mock('../store/redis.js', () => ({ redis: redisMock }));
vi.mock('../api/middleware/auth.js', () => ({ ensureAccount: vi.fn(async () => {}) }));
const modifyOrder = vi.fn(async (..._a: unknown[]): Promise<{ ok: true } | { error: string }> => ({ ok: true }));
vi.mock('../engine/order.js', () => ({
  placeOrders: vi.fn(async () => []),
  cancelOrders: vi.fn(async () => []),
  cancelByCloid: vi.fn(async () => []),
  updateLeverage: vi.fn(async () => {}),
  modifyOrder,
}));
vi.mock('../store/pg-sink.js', () => ({
  upsertUser: vi.fn(), updateUserBalance: vi.fn(), recordLedgerUpdate: vi.fn(), recordFunding: vi.fn(),
}));
// The captured requests were signed against HL TESTNET (phantom-agent source "b").
vi.mock('../config.js', () => ({
  config: {
    HL_API_URL: 'https://api.hyperliquid-testnet.xyz', DEFAULT_BALANCE: '10000', LOG_LEVEL: 'silent',
    INTERNAL_API_SECRET: 'test-internal-secret-0123456789',
  },
}));
const placeTrailingStop = vi.fn(async (_w: string, _a: unknown, _o?: unknown): Promise<{ oid: number } | { error: string }> => ({ oid: 4242 }));
vi.mock('../engine/trailingStop.js', () => ({ placeTrailingStop }));

const { exchangeRouter } = await import('../api/routes/exchange.js');
const app = new Hono();
app.route('/exchange', exchangeRouter);

const post = (body: unknown) =>
  app.request('/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
/** Unsigned `{ wallet }` bodies are accepted only from the internal caller (HP-01). */
const postInternal = (body: unknown) =>
  app.request('/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hypaper-internal': 'test-internal-secret-0123456789' },
    body: JSON.stringify(body),
  });

/** Same request, action keys in the order the HL UI's DevTools shows (alphabetical). */
const sortKeys = (a: Record<string, unknown>) => Object.fromEntries(Object.entries(a).sort(([x], [y]) => x.localeCompare(y)));

describe('POST /exchange — trailingStop intake', () => {
  beforeEach(() => {
    redisMock.flushall();
    placeTrailingStop.mockClear();
    placeTrailingStop.mockResolvedValue({ oid: 4242 });
    // The captures are real signatures, so their nonces cannot be re-minted; pin
    // the clock just after capture so they sit inside the (T-2d, T+1d) window.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fixtures.probeCaptures[0].nonce + 60_000);
  });
  afterEach(() => vi.useRealTimers());

  it('probe-signed request (msgpack key order) → recovers the main wallet, returns {type:"trailingStop",data:{oid}}', async () => {
    const cap = fixtures.probeCaptures[0];
    const res = await post(cap);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', response: { type: 'trailingStop', data: { oid: 4242 } } });
    expect(placeTrailingStop).toHaveBeenCalledTimes(1);
    expect(placeTrailingStop.mock.calls[0][0]).toBe(fixtures.mainWallet);
  });

  it('the SAME request with action keys SORTED (what the HL UI shows/sends) still recovers the same wallet', async () => {
    const cap = fixtures.probeCaptures[0];
    const res = await post({ ...cap, action: sortKeys(cap.action) });
    expect(res.status).toBe(200);
    expect(placeTrailingStop.mock.calls[0][0]).toBe(fixtures.mainWallet);
    // and the engine receives the canonical msgpack order
    expect(Object.keys(placeTrailingStop.mock.calls[0][1] as object)).toEqual([
      'type', 'asset', 'isBuy', 'sz', 'reduceOnly', 'retracement', 'activationPx',
    ]);
  });

  it('real HL web-UI requests (key-sorted JSON, expiresAfter, isFrontend, vaultAddress:null) recover the UI AGENT wallet', async () => {
    for (const cap of fixtures.uiCaptures) {
      vi.setSystemTime(cap.expiresAfter - 60_000);
      placeTrailingStop.mockClear();
      const res = await post(cap);
      expect(await res.json()).toEqual({ status: 'ok', response: { type: 'trailingStop', data: { oid: 4242 } } });
      // HyPaper has no agent → master mapping: the agent acts as its own account (pre-existing).
      expect(placeTrailingStop.mock.calls[0][0]).toBe(fixtures.agentWallet);
      // expiresAfter expires the REQUEST only — it is not handed to the engine, so the order never expires
      expect(placeTrailingStop.mock.calls[0]).toHaveLength(2);
    }
  });

  it('an expiresAfter in the past is refused: HTTP 200 + "Action already expired" (checked AFTER the signature, which covers expiresAfter)', async () => {
    // just past each capture's expiresAfter, but still inside the nonce window
    for (const cap of fixtures.uiCaptures) {
      vi.setSystemTime(cap.expiresAfter + 60_000);
      placeTrailingStop.mockClear();
      const res = await post(cap);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'err', response: 'Action already expired' });
      expect(placeTrailingStop).not.toHaveBeenCalled();
    }
  });

  it('modify of a trailing stop: HL\'s text comes back as HTTP 200; any other modify error stays HTTP 400', async () => {
    const wire = { a: 3, b: true, p: '80000', s: '0.00015', r: false, t: { limit: { tif: 'Gtc' } } };
    modifyOrder.mockResolvedValueOnce({ error: 'Attempted to modify to invalid new order' });
    let res = await postInternal({ wallet: '0xabc', action: { type: 'modify', oid: 5, order: wire } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'err', response: 'Attempted to modify to invalid new order' });

    modifyOrder.mockResolvedValueOnce({ error: 'Order 5 not found' });
    res = await postInternal({ wallet: '0xabc', action: { type: 'modify', oid: 5, order: wire } });
    expect(res.status).toBe(400);
  });

  it('semantic engine errors come back as HTTP 200 + {status:"err", response:<HL string>}', async () => {
    placeTrailingStop.mockResolvedValue({ error: 'Trailing stop retracement is invalid.' });
    const res = await post(fixtures.probeCaptures[0]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'err', response: 'Trailing stop retracement is invalid.' });
  });

  it.each([
    ['extra key', (a: any) => ({ ...a, foo: 1 })],
    ['missing activationPx', (a: any) => { const { activationPx, ...r } = a; return r; }],
    ['both px and pct', (a: any) => ({ ...a, retracement: { px: '5', pct: '5%' } })],
    ['sz as number', (a: any) => ({ ...a, sz: 0.00015 })],
  ])('malformed action (%s) → 400 deserialize error, engine never called', async (_n, mutate) => {
    const cap = fixtures.probeCaptures[0];
    const res = await post({ ...cap, action: mutate(cap.action) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ status: 'err', response: 'Failed to deserialize the JSON body into the target type' });
    expect(placeTrailingStop).not.toHaveBeenCalled();
  });

  it('a tampered body recovers a DIFFERENT (phantom) wallet — never the signer', async () => {
    const cap = fixtures.probeCaptures[0];
    const res = await post({ ...cap, action: { ...cap.action, sz: '99' } });
    expect(res.status).toBe(200);
    expect(placeTrailingStop.mock.calls[0][0]).not.toBe(fixtures.mainWallet);
  });

  it('replaying the same signed request is rejected by the nonce guard (existing behaviour)', async () => {
    const cap = fixtures.probeCaptures[0];
    expect((await post(cap)).status).toBe(200);
    const again = await post(cap);
    expect(again.status).toBe(400);
    expect(placeTrailingStop).toHaveBeenCalledTimes(1);
  });
});
