import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the liquidator vault approximation (engine/liquidator-vault.ts),
 * using the project's real RedisMock instead of a hand-rolled stub.
 *
 * IMPORTANT: vi.mock factories are hoisted above all imports by vitest, so
 * the RedisMock instance is created INSIDE the factory (via dynamic import)
 * rather than referencing a top-level const declared in this file.
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
  creditVaultPg: vi.fn(async () => {}),
  ensureVaultRowPg: vi.fn(async () => {}),
}));

import { redis as mockRedis } from '../store/redis.js';
import { creditVault, getVaultState, initVault } from '../engine/liquidator-vault.js';

describe('liquidator vault', () => {
  beforeEach(() => {
    mockRedis.flushall();
  });

  it('initVault seeds the vault with zero balance', async () => {
    await initVault();
    const state = await getVaultState();
    expect(state.totalCollected).toBe('0');
    expect(state.vaultAddress).toBe('0xabc1234567890000000000000000000000abcd');
  });

  it('creditVault increases totalCollected', async () => {
    await initVault();
    await creditVault('12.5');
    const state = await getVaultState();
    expect(parseFloat(state.totalCollected)).toBeCloseTo(12.5, 4);
  });

  it('creditVault accumulates across multiple calls', async () => {
    await initVault();
    await creditVault('10');
    await creditVault('5.5');
    const state = await getVaultState();
    expect(parseFloat(state.totalCollected)).toBeCloseTo(15.5, 4);
  });

  it('creditVault with zero amount does nothing', async () => {
    await initVault();
    await creditVault('0');
    const state = await getVaultState();
    expect(state.totalCollected).toBe('0');
  });

  it('getVaultState returns lastUpdated as a number', async () => {
    await initVault();
    await creditVault('1');
    const state = await getVaultState();
    expect(typeof state.lastUpdated).toBe('number');
    expect(state.lastUpdated).toBeGreaterThan(0);
  });

  it('creditVault is a no-op for a zero amount even when address is configured', async () => {
    await initVault();
    const before = await getVaultState();
    await creditVault('0');
    const after = await getVaultState();
    expect(after.totalCollected).toBe(before.totalCollected);
  });
});
