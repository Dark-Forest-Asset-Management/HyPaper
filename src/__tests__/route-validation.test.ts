import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

vi.mock('../api/middleware/auth.js', () => ({
  ensureAccount: vi.fn(async () => {}),
}));

vi.mock('../engine/order.js', () => ({
  placeOrders: vi.fn(async () => []),
  cancelOrders: vi.fn(async () => []),
  cancelByCloid: vi.fn(async () => []),
  updateLeverage: vi.fn(async () => {}),
}));

vi.mock('../store/pg-sink.js', () => ({
  upsertUser: vi.fn(async () => {}),
  updateUserBalance: vi.fn(async () => {}),
  recordLedgerUpdate: vi.fn(() => {}),
  recordFunding: vi.fn(() => {}),
}));

vi.mock('../config.js', () => ({
  config: {
    DEFAULT_BALANCE: '10000',
    LOG_LEVEL: 'silent',
    INTERNAL_API_SECRET: 'test-internal-secret-0123456789',
  },
}));

const INTERNAL = { 'content-type': 'application/json', 'x-hypaper-internal': 'test-internal-secret-0123456789' };

const { exchangeRouter } = await import('../api/routes/exchange.js');
const { hypaperRouter } = await import('../api/routes/hypaper.js');

describe('route validation', () => {
  beforeEach(() => {
    redisMock.flushall();
  });

  it('rejects NaN order sizes on /exchange', async () => {
    const app = new Hono();
    app.route('/exchange', exchangeRouter);

    const res = await app.request('/exchange', {
      method: 'POST',
      headers: INTERNAL,
      body: JSON.stringify({
        wallet: '0xabc',
        action: {
          type: 'order',
          orders: [
            {
              a: 0,
              b: true,
              p: '50000',
              s: 'NaN',
              r: false,
              t: { limit: { tif: 'Gtc' } },
            },
          ],
          grouping: 'na',
        },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      status: 'err',
      response: 'Size and price must be finite positive numbers',
    });
  });

  it('rejects Infinity order prices on /exchange', async () => {
    const app = new Hono();
    app.route('/exchange', exchangeRouter);

    const res = await app.request('/exchange', {
      method: 'POST',
      headers: INTERNAL,
      body: JSON.stringify({
        wallet: '0xabc',
        action: {
          type: 'order',
          orders: [
            {
              a: 0,
              b: true,
              p: 'Infinity',
              s: '1',
              r: false,
              t: { limit: { tif: 'Gtc' } },
            },
          ],
          grouping: 'na',
        },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      status: 'err',
      response: 'Size and price must be finite positive numbers',
    });
  });

  it('rejects NaN balances on /hypaper setBalance', async () => {
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);

    const res = await app.request('/hypaper', {
      method: 'POST',
      headers: INTERNAL,
      body: JSON.stringify({
        type: 'setBalance',
        user: '0xabc',
        balance: Number.NaN,
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Missing or invalid balance (must be a finite non-negative number)',
    });
  });

  it('rejects negative balances on /hypaper setBalance', async () => {
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);

    const res = await app.request('/hypaper', {
      method: 'POST',
      headers: INTERNAL,
      body: JSON.stringify({
        type: 'setBalance',
        user: '0xabc',
        balance: -1,
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Missing or invalid balance (must be a finite non-negative number)',
    });
  });

  it('accepts valid finite non-negative balances on /hypaper setBalance', async () => {
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);

    const res = await app.request('/hypaper', {
      method: 'POST',
      headers: INTERNAL,
      body: JSON.stringify({
        type: 'setBalance',
        user: '0xabc',
        balance: 123.45,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'ok',
      balance: '123.45',
    });
    await expect(redisMock.hget(KEYS.USER_ACCOUNT('0xabc'), 'balance')).resolves.toBe('123.45');
  });

  it('refuses the unsigned {wallet} form from a caller without the internal secret (HP-01)', async () => {
    const app = new Hono();
    app.route('/exchange', exchangeRouter);
    const body = JSON.stringify({ wallet: '0xabc', action: { type: 'cancel', cancels: [{ a: 0, o: 1 }] } });

    const anon = await app.request('/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(anon.status).toBe(401);

    const spoofed = await app.request('/exchange', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hypaper-internal': 'wrong' }, body });
    expect(spoofed.status).toBe(401);
  });

  it('refuses vaultAddress the signer does not own, honours it for a sub-account master (HP-02)', async () => {
    const app = new Hono();
    app.route('/exchange', exchangeRouter);
    const master = '0x1111111111111111111111111111111111111111';
    const sub = '0x2222222222222222222222222222222222222222';
    const victim = '0x3333333333333333333333333333333333333333';
    await redisMock.set(KEYS.SUBACCOUNT_MASTER(sub), master);
    const action = { type: 'cancel', cancels: [{ a: 0, o: 1 }] };

    const stranger = await app.request('/exchange', {
      method: 'POST', headers: INTERNAL,
      body: JSON.stringify({ wallet: master, vaultAddress: victim, action }),
    });
    expect(stranger.status).toBe(403);

    const owner = await app.request('/exchange', {
      method: 'POST', headers: INTERNAL,
      body: JSON.stringify({ wallet: master, vaultAddress: sub, action }),
    });
    expect(owner.status).toBe(200);
  });

  it('refuses /hypaper setBalance and resetAccount without the internal secret (HP-03)', async () => {
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);
    for (const type of ['setBalance', 'resetAccount']) {
      const res = await app.request('/hypaper', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, user: '0xabc', balance: 1e15 }),
      });
      expect(res.status).toBe(401);
    }
    const ok = await app.request('/hypaper', {
      method: 'POST', headers: INTERNAL,
      body: JSON.stringify({ type: 'setBalance', user: '0xabc', balance: 5 }),
    });
    expect(ok.status).toBe(200);
  });
});
