import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();
vi.mock('../store/redis.js', () => ({ redis: redisMock }));
vi.mock('../config.js', () => ({
  config: { FEES_ENABLED: false, FEE_RATE_TAKER: '0.00035', FEE_RATE_MAKER: '0.0001', LOG_LEVEL: 'silent', HL_API_URL: 'https://hl.test', TRAILING_ORDERSTATUS_LIVE: false },
}));
vi.mock('../utils/l2-cache.js', () => ({ getL2Book: vi.fn().mockResolvedValue(null) }));
let idCounter = 1000;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => ++idCounter),
  nextTid: vi.fn(async () => ++idCounter),
}));
const sharedEventBus = new EventEmitter();
vi.mock('../worker/index.js', () => ({ eventBus: sharedEventBus }));
vi.mock('../engine/margin.js', () => ({ checkMarginForOrder: vi.fn(async () => true), maxAffordableOrderSize: vi.fn(async () => null) }));

const { OrderMatcher } = await import('../worker/order-matcher.js');
const { placeTrailingStop } = await import('../engine/trailingStop.js');
const { placeOrders, cancelOrders } = await import('../engine/order.js');
const { getFrontendOpenOrders, getOpenOrders, getOrderStatus } = await import('../engine/position.js');
const { reconcileReduceOnlyStops } = await import('../engine/trailing-state.js');
const { shapeOrderUpdate } = await import('../ws/order-updates.js');
const { ERR_ALREADY_FINISHED } = await import('../engine/trailing-math.js');

const USER = '0xuser';
const OTHER = '0xother';
const COIN = 'BTC';
const ASSET = 0;

const stopAction = (over: Record<string, unknown> = {}) => ({
  type: 'trailingStop' as const, asset: ASSET, isBuy: false, sz: '0.00015', reduceOnly: true,
  retracement: { px: '3000' } as { px: string } | { pct: string }, activationPx: null as string | null, ...over,
});
const iocWire = (isBuy: boolean, sz: string, reduceOnly: boolean) => ({
  a: ASSET, b: isBuy, p: isBuy ? '90000' : '70000', s: sz, r: reduceOnly, t: { limit: { tif: 'Ioc' as const } },
});

describe('reduce-only trailing stop orphans (position goes flat / flips)', () => {
  let matcher: InstanceType<typeof OrderMatcher>;
  let orderEvents: Array<{ order: any; status: string }>;
  let batches: Array<{ updates: Array<{ order: any; status: string }> }>;
  let history: Array<{ oid: number; status: string; statusTimestamp: number }>;
  let fills: any[];

  beforeEach(async () => {
    redisMock.flushall();
    idCounter = 1000;
    sharedEventBus.removeAllListeners();
    matcher = new OrderMatcher(sharedEventBus);
    orderEvents = []; batches = []; history = []; fills = [];
    sharedEventBus.on('orderUpdate', (e) => orderEvents.push(e));
    sharedEventBus.on('orderUpdateBatch', (e) => batches.push(e));
    sharedEventBus.on('trailingHistory', (e) => history.push(e));
    sharedEventBus.on('fill', (e) => fills.push(e.fill));
    await redisMock.set(KEYS.MARKET_META, JSON.stringify({ universe: [{ name: COIN, szDecimals: 5 }] }));
    for (const u of [USER, OTHER]) await redisMock.hset(KEYS.USER_ACCOUNT(u), 'userId', u, 'balance', '1000');
    await redisMock.hset(KEYS.MARKET_MIDS, COIN, '82500');
    await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', '82500', 'markTs', String(Date.now()));
  });

  const setPos = async (user: string, szi: string) => {
    await redisMock.hset(KEYS.USER_POS(user, ASSET), 'userId', user, 'asset', String(ASSET), 'coin', COIN, 'szi', szi, 'entryPx', '80000', 'cumFunding', '0', 'cumFundingSinceOpen', '0', 'cumFundingSinceChange', '0');
    await redisMock.sadd(KEYS.USER_POSITIONS_SCOPED(user, ''), String(ASSET));
  };
  const status = (oid: number) => redisMock.hget(KEYS.ORDER(oid), 'status');
  const stop = async (over: Record<string, unknown> = {}, user = USER) => {
    const r = await placeTrailingStop(user, stopAction(over));
    if ('error' in r) throw new Error(r.error);
    return r.oid;
  };
  const wsEntry = (batchIdx: number, oid: number) => {
    const u = batches[batchIdx].updates.find((x) => x.order.oid === oid)!;
    return shapeOrderUpdate(u.order, u.status);
  };

  it('closing a LONG with a normal IOC auto-cancels the sell reduce-only stop: reduceOnlyCanceled, same ms as the fill', async () => {
    await setPos(USER, '0.00015');
    const oid = await stop();
    expect(await status(oid)).toBe('open');

    const [res] = await placeOrders(USER, [iocWire(false, '0.00015', true)], 'na');
    expect(res).toHaveProperty('filled');
    const closeFill = fills.at(-1);

    expect(await status(oid)).toBe('reduceOnlyCanceled');
    expect(Number(await redisMock.hget(KEYS.ORDER(oid), 'updatedAt'))).toBe(closeFill.time); // same ms as the closing fill
    expect(await redisMock.smembers(KEYS.ORDERS_TRAILING)).toEqual([]);
    expect(await getFrontendOpenOrders(USER)).toEqual([]);
    expect(await getOpenOrders(USER)).toEqual([]);
    expect(history.map((h) => [h.oid, h.status])).toEqual([[oid, 'open'], [oid, 'reduceOnlyCanceled']]);

    const st: any = await getOrderStatus(oid);
    expect(st.order.status).toBe('reduceOnlyCanceled');
    expect(st.order.statusTimestamp).toBe(closeFill.time);
    // frozen pre-cancel body: still the live "Activation immediate…" text, sz NOT zeroed (as on HL)
    expect(st.order.order).toMatchObject({ sz: '0.00015', isTrigger: true, triggerCondition: 'Activation immediate, retracement 3000, best 82500' });

    // an explicit cancel afterwards fails with HL's exact text
    expect(await cancelOrders(USER, [{ a: ASSET, o: oid }])).toEqual([{ error: ERR_ALREADY_FINISHED(ASSET) }]);
  });

  it('the orphan cancel rides the SAME ws frame as the closing order\'s filled, with HL\'s plain body', async () => {
    await setPos(USER, '0.00015');
    const oid = await stop();
    await placeOrders(USER, [iocWire(false, '0.00015', true)], 'na');

    expect(batches).toHaveLength(1);
    expect(batches[0].updates.map((u) => u.status)).toEqual(['filled', 'reduceOnlyCanceled']);
    const entry: any = wsEntry(0, oid);
    expect(entry.status).toBe('reduceOnlyCanceled');
    expect(entry.order).toMatchObject({ sz: '0.00015', reduceOnly: true, oid });
    expect(Object.keys(entry.order)).toEqual(['coin', 'side', 'limitPx', 'sz', 'oid', 'timestamp', 'origSz', 'reduceOnly']);
    expect(entry.statusTimestamp).toBe(batches[0].updates[0].order.updatedAt); // identical statusTimestamp
  });

  it('mirror: closing a SHORT auto-cancels the BUY reduce-only stop', async () => {
    await setPos(USER, '-0.00015');
    const oid = await stop({ isBuy: true });
    await placeOrders(USER, [iocWire(true, '0.00015', true)], 'na');
    expect(await status(oid)).toBe('reduceOnlyCanceled');
  });

  it('PARTIAL reduction keeps the stop open with its size UNCHANGED (HL probe R5)', async () => {
    await setPos(USER, '0.0003');
    const oid = await stop({ sz: '0.00045' });                       // larger than the position: accepted
    await placeOrders(USER, [iocWire(false, '0.00015', true)], 'na'); // 0.0003 → 0.00015
    expect(await status(oid)).toBe('open');
    expect((await getFrontendOpenOrders(USER))[0]).toMatchObject({ oid, sz: '0.00045' });
    expect(batches).toHaveLength(0);                                   // nothing orphaned → no extra frame
  });

  it('a position FLIP orphans the stop (HL probe R6)', async () => {
    await setPos(USER, '0.00015');
    const oid = await stop();
    await placeOrders(USER, [iocWire(false, '0.00045', false)], 'na'); // long 0.00015 → short 0.0003
    expect((await redisMock.hgetall(KEYS.USER_POS(USER, ASSET))).szi).toBe('-0.0003');
    expect(await status(oid)).toBe('reduceOnlyCanceled');
  });

  it('a stop placed on a FLAT account rests (HL accepts it); opening a position in the reducible direction keeps it, closing orphans it', async () => {
    const oid = await stop();                                          // sell RO stop, flat
    expect(await status(oid)).toBe('open');
    await placeOrders(USER, [iocWire(true, '0.00015', false)], 'na');  // open a long → the sell stop can now reduce
    expect(await status(oid)).toBe('open');
    await placeOrders(USER, [iocWire(false, '0.00015', true)], 'na');  // close it
    expect(await status(oid)).toBe('reduceOnlyCanceled');
  });

  it('non-reduce-only stops, other users\' stops and other assets are untouched', async () => {
    await setPos(USER, '0.00015');
    await setPos(OTHER, '0.00015');
    const openStop = await stop({ isBuy: true, reduceOnly: false });
    const otherUser = await stop({}, OTHER);
    await placeOrders(USER, [iocWire(false, '0.00015', true)], 'na'); // USER goes flat
    expect(await status(openStop)).toBe('open');
    expect(await status(otherUser)).toBe('open');
  });

  it('a stop that FIRES and closes the position also orphans a second reduce-only stop — all in the one [triggered, filled, …] frame', async () => {
    await setPos(USER, '0.00015');
    await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', '82760.2', 'markTs', String(Date.now()));
    const a = await stop({ retracement: { px: '5' } });
    const b = await stop({ retracement: { px: '3000' } });
    await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', '82750', 'markTs', String(Date.now())); // A's trigger (82755.2) crossed
    await matcher.matchAll();

    expect(await status(a)).toBe('filled');
    expect(await status(b)).toBe('reduceOnlyCanceled');
    expect(batches).toHaveLength(1);
    expect(batches[0].updates.map((u) => [u.order.oid, u.status])).toEqual([[a, 'triggered'], [a, 'filled'], [b, 'reduceOnlyCanceled']]);
  });

  describe('reconcileReduceOnlyStops (also what the liquidation path calls)', () => {
    it.each([
      ['flat', '0', false, 'reduceOnlyCanceled'],
      ['long, sell stop', '0.001', false, 'open'],
      ['short, sell stop (cannot reduce)', '-0.001', false, 'reduceOnlyCanceled'],
      ['short, buy stop', '-0.001', true, 'open'],
      ['long, buy stop (cannot reduce)', '0.001', true, 'reduceOnlyCanceled'],
    ])('%s → %s', async (_n, szi, isBuy, expected) => {
      const oid = await stop({ isBuy });
      const updates = await reconcileReduceOnlyStops(sharedEventBus, USER, ASSET, szi);
      expect(await status(oid)).toBe(expected);
      expect(updates.length).toBe(expected === 'open' ? 0 : 1);
    });

    it('does nothing for a different asset', async () => {
      const oid = await stop();
      expect(await reconcileReduceOnlyStops(sharedEventBus, USER, 5, '0')).toEqual([]);
      expect(await status(oid)).toBe('open');
    });
  });
});
