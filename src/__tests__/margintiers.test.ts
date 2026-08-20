import { describe, it, expect } from 'vitest';
import {
  getMarginTiersForCoin,
  maintenanceMarginForNotional,
  maintenanceMarginRateForNotional,
} from '../engine/marginTiers.js';
import type { HlMeta } from '../types/hl.js';

// Meta shape trimmed from the real HL testnet capture used in the
// hl-cross-maintenance-margin.md research doc (Cross Margin Updates task).
const testMeta: HlMeta = {
  universe: [
    { name: 'SOL', szDecimals: 2, maxLeverage: 10, marginTableId: 10 },
    { name: 'BTC', szDecimals: 5, maxLeverage: 40, marginTableId: 54 },
  ],
  marginTables: [
    [54, {
      description: 'tiered 40x',
      marginTiers: [
        { lowerBound: '0.0', maxLeverage: 40 },
        { lowerBound: '10000.0', maxLeverage: 25 },
        { lowerBound: '50000.0', maxLeverage: 10 },
      ],
    }],
  ],
};

describe('getMarginTiersForCoin', () => {
  it('returns null when meta is null', () => {
    expect(getMarginTiersForCoin(null, 'BTC')).toBeNull();
  });

  it('returns null when the coin is not in the universe', () => {
    expect(getMarginTiersForCoin(testMeta, 'DOGE')).toBeNull();
  });

  it('falls back to a flat single tier when marginTableId has no entry in marginTables', () => {
    // SOL has marginTableId 10, which isn't present in testMeta.marginTables
    // (matches real HL testnet data — id 10 is a flat, non-tiered table).
    const tiers = getMarginTiersForCoin(testMeta, 'SOL');
    expect(tiers).toEqual([{ lowerBound: '0.0', maxLeverage: 10 }]);
  });

  it('returns the real tiered schedule when present', () => {
    const tiers = getMarginTiersForCoin(testMeta, 'BTC');
    expect(tiers).toHaveLength(3);
    expect(tiers![0]).toEqual({ lowerBound: '0.0', maxLeverage: 40 });
  });
});

describe('maintenanceMarginForNotional — verified against real HL testnet data', () => {
  // These two numbers are the exact ones verified in
  // hl-cross-maintenance-margin.md against a live testnet account:
  //   SOL notional 9.7227  -> 0.486135
  //   BTC notional 263.2934 -> 3.291167 (rounded)
  //   sum -> 3.777302, matching HL's real crossMaintenanceMarginUsed exactly.

  it('SOL: flat 10x table, notional 9.7227 -> 0.486135', () => {
    const tiers = getMarginTiersForCoin(testMeta, 'SOL')!;
    const mm = maintenanceMarginForNotional(tiers, '9.7227');
    expect(parseFloat(mm)).toBeCloseTo(0.486135, 6);
  });

  it('BTC: tiered 40x table, notional 263.2934 stays in tier 0 -> ~3.291167', () => {
    const tiers = getMarginTiersForCoin(testMeta, 'BTC')!;
    const mm = maintenanceMarginForNotional(tiers, '263.2934');
    expect(parseFloat(mm)).toBeCloseTo(3.291167, 4);
  });

  it('sum of SOL + BTC matches HL real crossMaintenanceMarginUsed (3.777302)', () => {
    const solTiers = getMarginTiersForCoin(testMeta, 'SOL')!;
    const btcTiers = getMarginTiersForCoin(testMeta, 'BTC')!;
    const sol = parseFloat(maintenanceMarginForNotional(solTiers, '9.7227'));
    const btc = parseFloat(maintenanceMarginForNotional(btcTiers, '263.2934'));
    expect(sol + btc).toBeCloseTo(3.777302, 4);
  });

  it('crossing into tier 1 applies the higher rate + deduction, staying continuous at the boundary', () => {
    const tiers = getMarginTiersForCoin(testMeta, 'BTC')!;
    // Just below the $10,000 boundary (tier 0, 40x -> rate 1.25%):
    const justBelow = maintenanceMarginForNotional(tiers, '9999.99');
    // Just above the $10,000 boundary (tier 1, 25x -> rate 2%, with the
    // deduction term keeping the total from jumping discontinuously):
    const justAbove = maintenanceMarginForNotional(tiers, '10000.01');
    // The two should be very close to each other right at the boundary —
    // that's the entire point of the deduction term.
    expect(Math.abs(parseFloat(justAbove) - parseFloat(justBelow))).toBeLessThan(0.01);
  });

  it('returns 0 for an empty tier list', () => {
    expect(maintenanceMarginForNotional([], '1000')).toBe('0');
  });
});

describe('maintenanceMarginRateForNotional', () => {
  it('SOL flat table always returns the same rate regardless of size', () => {
    const tiers = getMarginTiersForCoin(testMeta, 'SOL')!;
    expect(parseFloat(maintenanceMarginRateForNotional(tiers, '1'))).toBeCloseTo(0.05, 6);
    expect(parseFloat(maintenanceMarginRateForNotional(tiers, '100000'))).toBeCloseTo(0.05, 6);
  });

  it('BTC tiered table returns a higher rate for larger notional', () => {
    const tiers = getMarginTiersForCoin(testMeta, 'BTC')!;
    const small = parseFloat(maintenanceMarginRateForNotional(tiers, '5000'));
    const large = parseFloat(maintenanceMarginRateForNotional(tiers, '60000'));
    expect(large).toBeGreaterThan(small);
  });
});