/**
 * Worker-level behaviour of trailing stops, using the REAL worker module (not mocked):
 *   - boot restore of the mark subscriptions + the `markSub` listener (Worker.start → wireMarkSubscriptions)
 *   - the 5 s HTTP mark refresh (Worker tick → refreshTrailingMarks)
 *   - scheduleCancel ("dead man's switch") and order-expiry cleanup of trailing stops
 *   - regression: expiry of NORMAL orders is unchanged
 *   - sub-account / vault stops and HIP-3 sub-dex coins
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();
vi.mock('../store/redis.js', () => ({ redis: redisMock }));
vi.mock('../config.js', () => ({
  config: {
    FEES_ENABLED: false, FEE_RATE_TAKER: '0.00035', FEE_RATE_MAKER: '0.0001', LOG_LEVEL: 'silent',
    HL_API_URL: 'https://hl.test', TRAILING_ORDERSTATUS_LIVE: false, L2_WS_ENABLED: false,
  },
}));
vi.mock('../utils/l2-cache.js', () => ({ getL2Book: vi.fn().mockResolvedValue(null) }));
let idCounter = 1000;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => ++idCounter),
  nextTid: vi.fn(async () => ++idCounter),
}));
vi.mock('../engine/margin.js', () => ({
  checkMarginForOrder: vi.fn(async () => true),
  maxAffordableOrderSize: vi.fn(async () => null),
}));
// the real worker module imports these; keep them inert
vi.mock('../store/db.js', () => ({ db: {} }));
vi.mock('../store/pg-sink.js', () => ({
  recordTwapActivated: vi.fn(), recordTwapHistory: vi.fn(), upsertUser: vi.fn(), updateUserBalance: vi.fn(),
  recordLedgerUpdate: vi.fn(), recordFunding: vi.fn(),
}));
vi.mock('../store/pg-queries.js', () => ({ upsertMarginTablesPg: vi.fn(async () => {}) }));

const { eventBus, ScheduleCancelWorker } = await import('../worker/index.js');
const { OrderMatcher } = await import('../worker/order-matcher.js');
const { wireMarkSubscriptions, refreshTrailingMarks } = await import('../worker/mark-feed.js');
const { placeTrailingStop } = await import('../engine/trailingStop.js');
const { placeOrders } = await import('../engine/order.js');
const { getFrontendOpenOrders } = await import('../engine/position.js');

const USER = '0xuser';
const VAULT = '0x1111111111111111111111111111111111111111';
const act = (over: Record<string, unknown> = {}) => ({
  type: 'trailingStop' as const, asset: 0, isBuy: false, sz: '0.00015', reduceOnly: true,
  retracement: { px: '3000' } as { px: string } | { pct: string }, activationPx: null as string | null, ...over,
});

describe('trailing stops — worker level', () => {
  let history: Array<{ oid: number; status: string }>;
  let updates: Array<{ order: any; status: string }>;

  const setMark = (coin: string, px: string, ageMs = 0) =>
    redisMock.hset(KEYS.MARKET_CTX(coin), 'markPx', px, 'markTs', String(Date.now() - ageMs));

  beforeEach(async () => {
    redisMock.flushall();
    idCounter = 1000;
    eventBus.removeAllListeners();
    history = []; updates = [];
    eventBus.on('trailingHistory', (e) => history.push(e));
    eventBus.on('orderUpdate', (e) => updates.push(e));
    await redisMock.set(KEYS.MARKET_META, JSON.stringify({ universe: [{ name: 'BTC', szDecimals: 5 }] }));
    await setMark('BTC', '82760.2');
  });

  const place = async (user = USER, over: Record<string, unknown> = {}) => {
    const r = await placeTrailingStop(user, act(over));
    if ('error' in r) throw new Error(r.error);
    return r.oid;
  };

  // ── mark subscriptions: boot restore + markSub listener ───────────────────

  describe('mark subscriptions (Worker.start → wireMarkSubscriptions)', () => {
    it('placing a stop asks the worker for that coin\'s activeAssetCtx subscription via the bus (markSub)', async () => {
      const subs: Array<{ type: string; coin: string }> = [];
      await wireMarkSubscriptions(eventBus, (s) => subs.push(s));
      await place();
      expect(subs).toEqual([{ type: 'activeAssetCtx', coin: 'BTC' }]);
    });

    it('at boot it restores the subscription of every coin that already has an open trailing stop', async () => {
      await place();                                   // a stop that "survived the restart" in Redis
      await redisMock.sadd(KEYS.ORDERS_TRAILING, '77');
      await redisMock.hset(KEYS.ORDER(77), 'coin', 'ETH');
      const subs: Array<{ type: string; coin: string }> = [];
      const restored = await wireMarkSubscriptions(eventBus, (s) => subs.push(s));
      expect(restored).toBe(2);
      expect(subs.map((s) => s.coin).sort()).toEqual(['BTC', 'ETH']);
      expect(subs.every((s) => s.type === 'activeAssetCtx')).toBe(true);
    });

    it('with no trailing stops nothing is restored; a markSub with no coin is ignored', async () => {
      const subs: unknown[] = [];
      expect(await wireMarkSubscriptions(eventBus, (s) => subs.push(s))).toBe(0);
      eventBus.emit('markSub', {});
      eventBus.emit('markSub', undefined);
      expect(subs).toEqual([]);
    });
  });

  // ── 5 s HTTP mark refresh ─────────────────────────────────────────────────

  describe('5 s mark refresh (Worker tick → refreshTrailingMarks)', () => {
    const okFetch = (byBody: Record<string, [unknown, unknown]>) =>
      vi.fn(async (_u: string, init: { body: string }) => {
        const data = byBody[JSON.stringify(JSON.parse(init.body))];
        return data ? { ok: true, status: 200, json: async () => data } : { ok: false, status: 500, json: async () => ({}) };
      });

    it('refreshes a stale mark only for coins with an open trailing stop', async () => {
      await place();                                         // BTC stop
      await setMark('BTC', '82000', 60_000);                 // stale
      await setMark('ETH', '2000', 60_000);                  // stale but NO stop → untouched
      const f = okFetch({
        [JSON.stringify({ type: 'metaAndAssetCtxs' })]: [{ universe: [{ name: 'BTC' }, { name: 'ETH' }] }, [{ markPx: '82500.0' }, { markPx: '2500' }]],
      });
      const n = await refreshTrailingMarks(Date.now(), f as any);
      expect(n).toBe(1);
      expect(await redisMock.hget(KEYS.MARKET_CTX('BTC'), 'markPx')).toBe('82500.0');
      expect(await redisMock.hget(KEYS.MARKET_CTX('ETH'), 'markPx')).toBe('2000');
    });

    it('does nothing (no network) when no trailing stop exists', async () => {
      const f = okFetch({});
      expect(await refreshTrailingMarks(Date.now(), f as any)).toBe(0);
      expect(f).not.toHaveBeenCalled();
    });
  });

  // ── scheduleCancel + expiry ───────────────────────────────────────────────

  describe('cancel-all paths', () => {
    it('scheduleCancel (dead man\'s switch) cancels trailing stops: status, trailing set, history row, order update', async () => {
      const oid = await place();
      history.length = 0; updates.length = 0;
      await redisMock.set(`user:${USER}:schedule_cancel`, String(Date.now() - 1000));
      await (new ScheduleCancelWorker() as any).tick();

      expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('cancelled');
      expect(await redisMock.smembers(KEYS.ORDERS_TRAILING)).toEqual([]);
      expect(history.map((h) => [h.oid, h.status])).toEqual([[oid, 'canceled']]);
      expect(updates.at(-1)).toMatchObject({ status: 'cancelled' });
      expect(await getFrontendOpenOrders(USER)).toEqual([]);
    });

    it('scheduleCancel before its deadline leaves the stop alone', async () => {
      const oid = await place();
      await redisMock.set(`user:${USER}:schedule_cancel`, String(Date.now() + 60_000));
      await (new ScheduleCancelWorker() as any).tick();
      expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('open');
    });

    it('sweepExpired (defensive) also cleans a trailing stop that somehow carries an expiry', async () => {
      const oid = await place();
      history.length = 0;
      await redisMock.zadd(KEYS.ORDERS_EXPIRY, Date.now() - 1, String(oid));
      await new OrderMatcher(eventBus).matchAll();
      expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('cancelled');
      expect(await redisMock.smembers(KEYS.ORDERS_TRAILING)).toEqual([]);
      expect(history.map((h) => h.status)).toEqual(['canceled']);
    });

    it('a trailing stop placed with expiresAfter is NEVER registered for expiry (request expiry only)', async () => {
      await place();
      expect(await redisMock.zrange(KEYS.ORDERS_EXPIRY, 0, -1)).toEqual([]);
    });
  });

  // ── regression: normal orders keep their (order-)expiry behaviour ──────────

  describe('regression — NORMAL orders\' expiresAfter behaviour is unchanged', () => {
    it('a resting limit order placed with expiresAfter is still registered for expiry and swept (cancelled) at the deadline', async () => {
      await redisMock.hset(KEYS.MARKET_MIDS, 'BTC', '82500');
      await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', '1000');
      const expiresAfter = Date.now() + 60_000;
      const [res] = await placeOrders(USER, [{ a: 0, b: true, p: '50000', s: '0.001', r: false, t: { limit: { tif: 'Gtc' } } }], 'na', { expiresAfter });
      const oid = (res as any).resting.oid;
      expect(await redisMock.zrange(KEYS.ORDERS_EXPIRY, 0, -1)).toContain(String(oid));
      expect(await redisMock.hget(KEYS.ORDER(oid), 'expiresAfter')).toBe(String(expiresAfter));

      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(expiresAfter + 1000);
        await new OrderMatcher(eventBus).matchAll();
      } finally { vi.useRealTimers(); }
      expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('cancelled');
    });
  });

  // ── sub-account / vault ───────────────────────────────────────────────────

  describe('sub-account / vault stops', () => {
    it('a stop placed for a vault lives on the VAULT\'s account, not the master\'s', async () => {
      const oid = await place(VAULT);
      expect(await redisMock.hget(KEYS.ORDER(oid), 'userId')).toBe(VAULT);
      expect((await getFrontendOpenOrders(VAULT)).map((o) => o.oid)).toEqual([oid]);
      expect(await getFrontendOpenOrders(USER)).toEqual([]);
    });
  });

  // ── HIP-3 sub-dex coins ──────────────────────────────────────────────────

  describe('HIP-3 sub-dex coins (asset id 100000 + dexIdx*10000 + idx, coin "xyz:AAPL")', () => {
    const XYZ_ASSET = 110_000;   // perpDexs[1] = xyz, universe idx 0

    beforeEach(async () => {
      await redisMock.set(KEYS.MARKET_PERPDEXS, JSON.stringify([null, { name: 'xyz' }]));
      await redisMock.set(KEYS.MARKET_META_DEX('xyz'), JSON.stringify({ universe: [{ name: 'xyz:AAPL', szDecimals: 3 }] }));
      await setMark('xyz:AAPL', '250.5');
      await redisMock.hset(KEYS.MARKET_MIDS, 'xyz:AAPL', '250.4');
    });

    it('is placed on the sub-dex scope: visible with dex "xyz", NOT in the native list; px normalised to 6−3 = 3 decimals', async () => {
      const oid = await place(USER, { asset: XYZ_ASSET, sz: '0.05', retracement: { px: '0.1234' } });
      expect(await redisMock.hget(KEYS.ORDER(oid), 'coin')).toBe('xyz:AAPL');
      const sub = await getFrontendOpenOrders(USER, 'xyz');
      expect(sub.map((o) => o.oid)).toEqual([oid]);
      expect(sub[0]).toMatchObject({ coin: 'xyz:AAPL', triggerCondition: 'Activation immediate, retracement 0.123, best 250.5', triggerPx: '250.377' });
      expect(await getFrontendOpenOrders(USER, '')).toEqual([]);
    });

    it('the mark refresh asks the sub-dex endpoint ({type:"metaAndAssetCtxs", dex:"xyz"}) for it', async () => {
      await place(USER, { asset: XYZ_ASSET, sz: '0.05', retracement: { px: '1' } });
      await setMark('xyz:AAPL', '250.5', 60_000);
      const f = vi.fn(async (_u: string, init: { body: string }) => ({
        ok: true, status: 200,
        json: async () => (JSON.parse(init.body).dex === 'xyz'
          ? [{ universe: [{ name: 'xyz:AAPL' }] }, [{ markPx: '251.0' }]] : [{ universe: [] }, []]),
      }));
      expect(await refreshTrailingMarks(Date.now(), f as any)).toBe(1);
      expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ type: 'metaAndAssetCtxs', dex: 'xyz' });
      expect(await redisMock.hget(KEYS.MARKET_CTX('xyz:AAPL'), 'markPx')).toBe('251.0');
    });

    it('fires on its own mark and fills the sub-dex position', async () => {
      await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', '1000');
      await redisMock.hset(KEYS.USER_POS(USER, XYZ_ASSET), 'userId', USER, 'asset', String(XYZ_ASSET), 'coin', 'xyz:AAPL', 'szi', '0.05', 'entryPx', '240', 'cumFunding', '0', 'cumFundingSinceOpen', '0', 'cumFundingSinceChange', '0');
      await redisMock.sadd(KEYS.USER_POSITIONS_SCOPED(USER, 'xyz'), String(XYZ_ASSET));
      const fills: any[] = [];
      eventBus.on('fill', (e) => fills.push(e.fill));
      const oid = await place(USER, { asset: XYZ_ASSET, sz: '0.05', retracement: { px: '1' } });
      await setMark('xyz:AAPL', '249.4');                       // 250.5 − 1 = 249.5 → crossed
      await new OrderMatcher(eventBus).matchAll();
      expect(fills.map((f) => [f.oid, f.coin, f.dir])).toEqual([[oid, 'xyz:AAPL', 'Close Long']]);
      expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('filled');
    });
  });
});
