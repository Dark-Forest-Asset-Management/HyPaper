/**
 * A liquidation flattens the position through engine/liquidation.ts' own writer (closePositionSlice), NOT through
 * the matcher's executeFill — so it needs its own orphan hook for reduce-only trailing stops.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../store/redis.js', async () => {
  const { RedisMock } = await import('./helpers/redis-mock.js');
  return { redis: new RedisMock() };
});
vi.mock('../config.js', () => ({
  config: { LIQUIDATOR_VAULT_ADDRESS: '0xabc1234567890000000000000000000000abcd', LOG_LEVEL: 'silent' },
}));
vi.mock('../store/pg-queries.js', () => ({
  insertLiquidationEventPg: vi.fn(async () => {}),
  creditVaultPg: vi.fn(async () => {}),
  ensureVaultRowPg: vi.fn(async () => {}),
}));
const sharedBus = new EventEmitter();
vi.mock('../worker/index.js', () => ({ eventBus: sharedBus }));

import { redis as redisMock } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { executeLiquidation } from '../engine/liquidation.js';
import { fieldsFrom, buildTrailingBody } from '../engine/trailing-math.js';

const USER = '0xliq';
const OTHER = '0xother';

/** Write a trailing stop straight into Redis, the way placement leaves it. */
async function seedStop(oid: number, user: string, over: { isBuy?: boolean; reduceOnly?: boolean; asset?: number } = {}) {
  const isBuy = over.isBuy ?? false;
  const data: Record<string, string> = {
    oid: String(oid), userId: user, asset: String(over.asset ?? 0), coin: 'XRP', isBuy: String(isBuy), sz: '10',
    limitPx: '0.4', orderType: 'trailingStop', tif: 'Gtc', reduceOnly: String(over.reduceOnly ?? true), grouping: 'na',
    status: 'open', filledSz: '0', avgPx: '0', createdAt: '1000', updatedAt: '1000', triggerPx: '0.4',
    ...fieldsFrom({ isBuy, kind: 'px', value: '0.1', activationPx: null, szDecimals: 0 }, { activated: true, best: '0.5' }),
  };
  await redisMock.hset(KEYS.ORDER(oid), data);
  await redisMock.sadd(KEYS.ORDERS_TRAILING, String(oid));
  await redisMock.zadd(KEYS.USER_ORDERS_SCOPED(user, ''), 1000, String(oid));
}

describe('liquidation orphans reduce-only trailing stops', () => {
  let history: Array<{ oid: number; status: string; statusTimestamp: number }>;
  let batches: Array<{ userId: string; updates: Array<{ order: any; status: string }> }>;

  beforeEach(async () => {
    (redisMock as any).flushall();
    sharedBus.removeAllListeners();
    history = []; batches = [];
    sharedBus.on('trailingHistory', (e) => history.push(e));
    sharedBus.on('orderUpdateBatch', (e) => batches.push(e));
    // 50 XRP long @ $1, price crashed to $0.50, tiny balance → liquidatable (same fixture as the liquidation tests)
    await redisMock.hset(KEYS.USER_POS(USER, 0), 'szi', '50', 'coin', 'XRP', 'entryPx', '1');
    await redisMock.hset(KEYS.MARKET_MIDS, 'XRP', '0.5');
    await redisMock.hset(KEYS.USER_LEV(USER, 0), 'leverage', '5', 'isCross', 'true');
    await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'balance', '1');
    await redisMock.sadd(KEYS.USER_POSITIONS_SCOPED(USER, ''), '0');
  });

  it('a full liquidation auto-cancels the open reduce-only stop: reduceOnlyCanceled + history row + one orderUpdates frame', async () => {
    await seedStop(901, USER);
    expect(await executeLiquidation(USER, 0)).toBe(true);

    expect(await redisMock.hgetall(KEYS.USER_POS(USER, 0))).toEqual({});             // position gone
    expect(await redisMock.hget(KEYS.ORDER(901), 'status')).toBe('reduceOnlyCanceled');
    expect(await redisMock.smembers(KEYS.ORDERS_TRAILING)).toEqual([]);
    expect(history.map((h) => [h.oid, h.status])).toEqual([[901, 'reduceOnlyCanceled']]);
    expect(batches).toHaveLength(1);
    expect(batches[0].userId).toBe(USER);
    expect(batches[0].updates.map((u) => [u.order.oid, u.status])).toEqual([[901, 'reduceOnlyCanceled']]);
    // the frozen body is the live pre-cancel body, like every other orphan
    expect(JSON.parse(await redisMock.hget(KEYS.ORDER(901), 'trSnap') as string)).toMatchObject({ isTrigger: true, sz: '10' });
    expect(buildTrailingBody({ ...(await redisMock.hgetall(KEYS.ORDER(901))) }, false).triggerCondition).toBe('Activation immediate, retracement 0.1, best 0.5');
  });

  it('non-reduce-only stops, another user\'s stops and stops on other assets are left alone', async () => {
    await seedStop(902, USER, { isBuy: true, reduceOnly: false });
    await seedStop(903, OTHER);
    await seedStop(904, USER, { asset: 5 });
    await executeLiquidation(USER, 0);
    for (const oid of [902, 903, 904]) expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('open');
    expect(batches).toHaveLength(0);
  });

  it('no trailing stops anywhere → the hook never touches the worker (no batch, no history)', async () => {
    await executeLiquidation(USER, 0);
    expect(batches).toHaveLength(0);
    expect(history).toHaveLength(0);
  });
});
