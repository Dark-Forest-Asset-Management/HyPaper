import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({ redis: redisMock }));
vi.mock('../config.js', () => ({
  config: { HL_API_URL: 'https://hl.test', LOG_LEVEL: 'silent' },
}));

const {
  getMark, getFreshMark, refreshMarks, getTrailingCoins, MARK_FRESH_MS, MARK_POLL_THRESHOLD_MS,
} = await import('../worker/mark-feed.js');
const { PriceUpdater } = await import('../worker/price-updater.js');

const NOW = 1_800_000_000_000;

function okFetch(byBody: Record<string, [unknown, unknown]>) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const key = JSON.stringify(JSON.parse(init.body));
    const data = byBody[key];
    if (!data) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => data };
  });
}

describe('PriceUpdater stamps the mark', () => {
  beforeEach(() => redisMock.flushall());

  it('activeAssetCtx writes markPx AND markTs, and markPx is distinct from midPx', async () => {
    const updater = new PriceUpdater(() => {}, new EventEmitter());
    const before = Date.now();
    await updater.handleMessage('activeAssetCtx', {
      coin: 'BTC',
      ctx: { markPx: '82499.0', midPx: '82516.5', oraclePx: '82500', funding: '0', openInterest: '1', prevDayPx: '1', dayNtlVlm: '1', premium: '0' },
    });
    const ctx = await redisMock.hgetall(KEYS.MARKET_CTX('BTC'));
    expect(ctx.markPx).toBe('82499.0');
    expect(ctx.midPx).toBe('82516.5');
    expect(Number(ctx.markTs)).toBeGreaterThanOrEqual(before);
    // the mid feeds the legacy matcher, the mark feeds trailing stops — never conflated
    expect(await redisMock.hget(KEYS.MARKET_MIDS, 'BTC')).toBe('82516.5');
  });
});

describe('mark-feed freshness', () => {
  beforeEach(() => redisMock.flushall());

  it('getMark returns null for missing/empty/non-positive marks', async () => {
    expect(await getMark('BTC')).toBeNull();
    await redisMock.hset(KEYS.MARKET_CTX('BTC'), 'markPx', '');
    expect(await getMark('BTC')).toBeNull();
    await redisMock.hset(KEYS.MARKET_CTX('BTC'), 'markPx', '0');
    expect(await getMark('BTC')).toBeNull();
  });

  it('a boot-seeded mark (no markTs) is readable but never "fresh"', async () => {
    await redisMock.hset(KEYS.MARKET_CTX('BTC'), 'markPx', '82000');
    expect(await getMark('BTC')).toEqual({ px: '82000', ts: 0 });
    expect(await getFreshMark('BTC', NOW)).toBeNull();
  });

  it('getFreshMark honours the max age exactly', async () => {
    await redisMock.hset(KEYS.MARKET_CTX('BTC'), 'markPx', '82000', 'markTs', String(NOW - MARK_FRESH_MS));
    expect(await getFreshMark('BTC', NOW)).toBe('82000');
    expect(await getFreshMark('BTC', NOW + 1)).toBeNull();
  });
});

describe('mark-feed HTTP fallback', () => {
  beforeEach(() => redisMock.flushall());

  it('refreshes only stale coins, in ONE request per dex, writing markPx/markTs and not touching mids', async () => {
    await redisMock.hset(KEYS.MARKET_MIDS, 'BTC', '70000');
    // BTC stale (no ts); ETH fresh → must not be refreshed; xyz:AAPL stale in its own dex.
    await redisMock.hset(KEYS.MARKET_CTX('ETH'), 'markPx', '2000', 'markTs', String(NOW - 1000));
    const fetchFn = okFetch({
      [JSON.stringify({ type: 'metaAndAssetCtxs' })]: [
        { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
        [{ markPx: '82499.0' }, { markPx: '9999' }],
      ],
      [JSON.stringify({ type: 'metaAndAssetCtxs', dex: 'xyz' })]: [
        { universe: [{ name: 'xyz:AAPL' }] },
        [{ markPx: '250.5' }],
      ],
    });

    const n = await refreshMarks(['BTC', 'ETH', 'xyz:AAPL'], NOW, fetchFn as any);

    expect(n).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2); // native + xyz
    expect(await getMark('BTC')).toEqual({ px: '82499.0', ts: NOW });
    expect(await getMark('xyz:AAPL')).toEqual({ px: '250.5', ts: NOW });
    expect((await getMark('ETH'))!.px).toBe('2000');                 // fresh → untouched
    expect(await redisMock.hget(KEYS.MARKET_MIDS, 'BTC')).toBe('70000'); // mids untouched
  });

  it('skips the network entirely when every mark is fresh', async () => {
    await redisMock.hset(KEYS.MARKET_CTX('BTC'), 'markPx', '82000', 'markTs', String(NOW - MARK_POLL_THRESHOLD_MS));
    const fetchFn = okFetch({});
    expect(await refreshMarks(['BTC'], NOW, fetchFn as any)).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('swallows HTTP failures (returns 0, leaves the old mark)', async () => {
    await redisMock.hset(KEYS.MARKET_CTX('BTC'), 'markPx', '82000', 'markTs', String(NOW - 60_000));
    const fetchFn = okFetch({}); // every request → 500
    expect(await refreshMarks(['BTC'], NOW, fetchFn as any)).toBe(0);
    expect((await getMark('BTC'))!.px).toBe('82000');
    expect(await getFreshMark('BTC', NOW)).toBeNull(); // still stale → engine will not trade on it
  });

  it('getTrailingCoins lists the distinct coins of open trailing stops', async () => {
    await redisMock.sadd(KEYS.ORDERS_TRAILING, '1', '2', '3');
    await redisMock.hset(KEYS.ORDER(1), 'coin', 'BTC');
    await redisMock.hset(KEYS.ORDER(2), 'coin', 'BTC');
    await redisMock.hset(KEYS.ORDER(3), 'coin', 'xyz:AAPL');
    expect([...(await getTrailingCoins())].sort()).toEqual(['BTC', 'xyz:AAPL']);
  });
});
