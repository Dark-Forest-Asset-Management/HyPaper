import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Liquidation engine tests — uses the project's real RedisMock
 * (src/__tests__/helpers/redis-mock.ts) so pipeline/hgetall/smembers
 * behaviour matches exactly what production code gets from ioredis.
 *
 * KEYS is imported from the real store/keys.ts rather than hardcoded
 * string literals, so these tests stay correct even if key naming
 * changes later.
 *
 * IMPORTANT: vi.mock factories are hoisted above all imports by vitest,
 * so they cannot close over a top-level `const` declared in this file
 * (temporal dead zone). The mock instance is created INSIDE the factory
 * and re-exported, then re-imported below for use in tests.
 */

vi.mock('../store/redis.js', async () => {
  const { RedisMock } = await import('./helpers/redis-mock.js');
  return { redis: new RedisMock() };
});

vi.mock('../config.js', () => ({
  config: {
    LIQUIDATOR_VAULT_ADDRESS: '0xabc1234567890000000000000000000000abcd',
    LOG_LEVEL: 'silent',
  },
}));

vi.mock('../store/pg-queries.js', () => ({
  insertLiquidationEventPg: vi.fn(async () => {}),
  creditVaultPg: vi.fn(async () => {}),
  ensureVaultRowPg: vi.fn(async () => {}),
}));

import { redis as mockRedis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { computeMaintenanceMargin, checkLiquidation } from '../engine/liquidation.js';

describe('computeMaintenanceMargin', () => {
  it('calculates 1.25% rate for 40x leverage', () => {
    const result = computeMaintenanceMargin('10', '100', 40);
    // positionNotional = 10 * 100 = 1000
    // rate = 1 / (40*2) = 1/80 = 0.0125
    // maintMargin = 1000 * 0.0125 = 12.5
    expect(result.positionNotional).toBe('1000');
    expect(parseFloat(result.maintenanceMarginRate)).toBeCloseTo(0.0125, 4);
    expect(parseFloat(result.maintenanceMargin)).toBeCloseTo(12.5, 2);
  });

  it('calculates ~16.7% rate for 3x leverage', () => {
    const result = computeMaintenanceMargin('10', '100', 3);
    expect(parseFloat(result.maintenanceMarginRate)).toBeCloseTo(0.16667, 4);
  });

  it('uses absolute value of szi for shorts (same margin as equivalent long)', () => {
    const long = computeMaintenanceMargin('10', '100', 10);
    const short = computeMaintenanceMargin('-10', '100', 10);
    expect(long.maintenanceMargin).toBe(short.maintenanceMargin);
  });

  it('matches the example: 50 XRP @ $1, 5x leverage', () => {
    const result = computeMaintenanceMargin('50', '1', 5);
    expect(result.positionNotional).toBe('50');
    expect(parseFloat(result.maintenanceMarginRate)).toBeCloseTo(0.1, 4);
    expect(parseFloat(result.maintenanceMargin)).toBeCloseTo(5, 4);
  });

  it('clamps leverage to minimum 1 to avoid divide by zero', () => {
    expect(() => computeMaintenanceMargin('10', '100', 0)).not.toThrow();
    const result = computeMaintenanceMargin('10', '100', 0);
    expect(parseFloat(result.maintenanceMarginRate)).toBeCloseTo(0.5, 4);
  });
});

describe('checkLiquidation', () => {
  beforeEach(() => {
    mockRedis.flushall();
  });

  it('returns shouldLiquidate=false when no position exists', async () => {
    const result = await checkLiquidation('0xuser', 0);
    expect(result.shouldLiquidate).toBe(false);
    expect(result.accountEquity).toBe('0');
  });

  it('returns shouldLiquidate=false when szi is zero', async () => {
    await mockRedis.hset(KEYS.USER_POS('0xuser', 0), 'szi', '0', 'coin', 'XRP', 'entryPx', '1');
    const result = await checkLiquidation('0xuser', 0);
    expect(result.shouldLiquidate).toBe(false);
  });

  it('returns shouldLiquidate=false when no mark price is available for the coin', async () => {
    await mockRedis.hset(KEYS.USER_POS('0xuser', 0), 'szi', '50', 'coin', 'XRP', 'entryPx', '1');
    // No mids seeded -> KEYS.MARKET_MIDS lookup returns {}
    const result = await checkLiquidation('0xuser', 0);
    expect(result.shouldLiquidate).toBe(false);
  });

  it('flags liquidation when account equity drops below maintenance margin', async () => {
    // 50 XRP long @ entry $1, price crashes to $0.50, 5x leverage, tiny balance
    await mockRedis.hset(KEYS.USER_POS('0xuser', 0), 'szi', '50', 'coin', 'XRP', 'entryPx', '1');
    await mockRedis.hset(KEYS.MARKET_MIDS, 'XRP', '0.5');
    await mockRedis.hset(KEYS.USER_LEV('0xuser', 0), 'leverage', '5', 'isCross', 'true');
    await mockRedis.hset(KEYS.USER_ACCOUNT('0xuser'), 'balance', '1');
    await mockRedis.sadd(KEYS.USER_POSITIONS_SCOPED('0xuser', ''), '0');

    const result = await checkLiquidation('0xuser', 0);

    // unrealizedPnl = (0.5 - 1) * 50 = -25
    // accountValue  = balance(1) + (-25) = -24
    // maintMargin   = notional(50*0.5=25) * rate(1/(2*5)=0.1) = 2.5
    // -24 < 2.5 -> should liquidate
    expect(result.shouldLiquidate).toBe(true);
    expect(parseFloat(result.accountEquity)).toBeCloseTo(-24, 2);
    expect(parseFloat(result.maintenanceMargin)).toBeCloseTo(2.5, 2);
  });

  it('does NOT flag liquidation when equity is comfortably above maintenance margin', async () => {
    // Same position, but price only dipped slightly and balance is healthy.
    await mockRedis.hset(KEYS.USER_POS('0xuser', 0), 'szi', '50', 'coin', 'XRP', 'entryPx', '1');
    await mockRedis.hset(KEYS.MARKET_MIDS, 'XRP', '0.98');
    await mockRedis.hset(KEYS.USER_LEV('0xuser', 0), 'leverage', '5', 'isCross', 'true');
    await mockRedis.hset(KEYS.USER_ACCOUNT('0xuser'), 'balance', '90');
    await mockRedis.sadd(KEYS.USER_POSITIONS_SCOPED('0xuser', ''), '0');

    const result = await checkLiquidation('0xuser', 0);

    // unrealizedPnl = (0.98 - 1) * 50 = -1
    // accountValue  = 90 + (-1) = 89
    // maintMargin   = (50*0.98=49) * 0.1 = 4.9
    // 89 > 4.9 -> safe
    expect(result.shouldLiquidate).toBe(false);
  });
});
