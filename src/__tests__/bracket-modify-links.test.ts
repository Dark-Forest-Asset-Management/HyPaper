import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();
vi.mock('../store/redis.js', () => ({ redis: redisMock }));
vi.mock('../config.js', () => ({
  config: { FEES_ENABLED: false, FEE_RATE_TAKER: '0.00035', FEE_RATE_MAKER: '0.0001', LOG_LEVEL: 'silent' },
}));
vi.mock('../utils/l2-cache.js', () => ({ getL2Book: vi.fn().mockResolvedValue(null) }));
let tidCounter = 0;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => ++tidCounter),
  nextTid: vi.fn(async () => ++tidCounter),
}));
const sharedEventBus = new EventEmitter();
vi.mock('../worker/index.js', () => ({ eventBus: sharedEventBus }));

const { placeOrders, modifyOrder, batchModifyOrders } = await import('../engine/order.js');

const USER = '0xtest';
const COIN = 'BTC';
const ASSET = 0;

/** A normalTpsl bracket on an existing long: the parent is a resting reduce-only sell limit above the mid
 *  (no margin / leverage path involved); TP and SL are reduce-only market triggers. */
async function seedAndPlaceBracket(): Promise<{ parent: number; tp: number; sl: number }> {
  await redisMock.set(KEYS.MARKET_META, JSON.stringify({ universe: [{ name: COIN, szDecimals: 5 }] }));
  await redisMock.hset(KEYS.MARKET_MIDS, COIN, '50000');
  await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', '100000');
  await redisMock.hset(
    KEYS.USER_POS(USER, ASSET),
    'userId', USER, 'asset', '0', 'coin', COIN, 'szi', '2', 'entryPx', '50000',
    'cumFunding', '0', 'cumFundingSinceOpen', '0', 'cumFundingSinceChange', '0',
  );
  await redisMock.sadd(KEYS.USER_POSITIONS(USER), '0');
  const statuses = await placeOrders(USER, [
    { a: ASSET, b: false, p: '51000', s: '1', r: true, t: { limit: { tif: 'Gtc' } } },
    { a: ASSET, b: false, p: '52000', s: '1', r: true, t: { limit: { tif: 'Gtc' }, trigger: { isMarket: true, triggerPx: '52000', tpsl: 'tp' } } },
    { a: ASSET, b: false, p: '49000', s: '1', r: true, t: { limit: { tif: 'Gtc' }, trigger: { isMarket: true, triggerPx: '49000', tpsl: 'sl' } } },
  ], 'normalTpsl');
  const oids = statuses.map((s) => (typeof s === 'object' && s && 'resting' in s ? s.resting!.oid : -1));
  expect(oids.every((o) => o > 0), JSON.stringify(statuses)).toBe(true);
  return { parent: oids[0], tp: oids[1], sl: oids[2] };
}

describe('bracket links survive a modify', () => {
  beforeEach(() => {
    redisMock.flushall();
    tidCounter = 100;
    sharedEventBus.removeAllListeners();
  });

  it('wires parent / children / siblings at placement', async () => {
    const { parent, tp, sl } = await seedAndPlaceBracket();
    expect((await redisMock.smembers(KEYS.ORDER_CHILDREN(parent))).sort()).toEqual([String(tp), String(sl)].sort());
    expect(await redisMock.get(KEYS.ORDER_PARENT(tp))).toBe(String(parent));
    expect(await redisMock.smembers(KEYS.ORDER_BRACKET(tp))).toEqual([String(sl)]);
    expect(await redisMock.smembers(KEYS.ORDER_BRACKET(sl))).toEqual([String(tp)]);
  });

  it('a modified TP child keeps its parent pointer and OCO sibling; the old oid is unlinked', async () => {
    const { parent, tp, sl } = await seedAndPlaceBracket();
    const r = await modifyOrder(USER, tp, {
      a: ASSET, b: false, p: '53000', s: '1', r: true, t: { limit: { tif: 'Gtc' }, trigger: { isMarket: true, triggerPx: '53000', tpsl: 'tp' } },
    });
    expect(r).toEqual({ ok: true });
    const open = await redisMock.smembers(KEYS.ORDERS_TRIGGERS);
    const newTp = open.map(Number).find((o) => o !== parent && o !== sl && o !== tp);
    expect(newTp, `open set ${open}`).toBeDefined();
    expect(await redisMock.hget(KEYS.ORDER(tp), 'status')).toBe('cancelled');
    // replacement is the child now
    expect(await redisMock.get(KEYS.ORDER_PARENT(newTp!))).toBe(String(parent));
    expect(await redisMock.smembers(KEYS.ORDER_BRACKET(newTp!))).toEqual([String(sl)]);
    expect(await redisMock.smembers(KEYS.ORDER_BRACKET(sl))).toEqual([String(newTp)]);
    expect((await redisMock.smembers(KEYS.ORDER_CHILDREN(parent))).sort()).toEqual([String(newTp), String(sl)].sort());
    // old oid holds nothing
    expect(await redisMock.get(KEYS.ORDER_PARENT(tp))).toBeNull();
    expect(await redisMock.smembers(KEYS.ORDER_BRACKET(tp))).toEqual([]);
  });

  it('batchModify carries the links the same way', async () => {
    const { parent, tp, sl } = await seedAndPlaceBracket();
    const statuses = await batchModifyOrders(USER, [{
      oid: sl,
      order: { a: ASSET, b: false, p: '48000', s: '1', r: true, t: { limit: { tif: 'Gtc' }, trigger: { isMarket: true, triggerPx: '48000', tpsl: 'sl' } } },
    }]);
    const newSl = (statuses[0] as { resting: { oid: number } }).resting.oid;
    expect(await redisMock.get(KEYS.ORDER_PARENT(newSl))).toBe(String(parent));
    expect(await redisMock.smembers(KEYS.ORDER_BRACKET(tp))).toEqual([String(newSl)]);
    expect(await redisMock.smembers(KEYS.ORDER_BRACKET(newSl))).toEqual([String(tp)]);
  });

  it('a modified PARENT cascade-cancels its open children (HL modify on a normalTpsl entry)', async () => {
    const { parent, tp, sl } = await seedAndPlaceBracket();
    const r = await modifyOrder(USER, parent, {
      a: ASSET, b: false, p: '51500', s: '1', r: true, t: { limit: { tif: 'Gtc' } },
    });
    expect(r).toEqual({ ok: true });
    expect(await redisMock.hget(KEYS.ORDER(tp), 'status')).toBe('cancelled');
    expect(await redisMock.hget(KEYS.ORDER(sl), 'status')).toBe('cancelled');
    expect(await redisMock.smembers(KEYS.ORDER_CHILDREN(parent))).toEqual([]);
    expect(await redisMock.get(KEYS.ORDER_PARENT(tp))).toBeNull();
  });
});
