import { describe, it, expect, vi } from 'vitest';

// Mock redis to prevent real connection during import
vi.mock('../store/redis.js', () => ({
  redis: {},
}));

import { calculatePositionUnrealizedPnl, calculateLiquidationPrice } from '../engine/margin.js';

describe('margin calculations', () => {
  describe('calculatePositionUnrealizedPnl', () => {
    it('returns 0 for zero position', () => {
      expect(calculatePositionUnrealizedPnl('0', '50000', '51000')).toBe('0');
    });

    describe('long positions (szi > 0)', () => {
      it('calculates profit when price goes up', () => {
        // Long 1 BTC @ 50000, mark at 51000 → PnL = (51000-50000)*1 = 1000
        expect(calculatePositionUnrealizedPnl('1', '50000', '51000')).toBe('1000');
      });

      it('calculates loss when price goes down', () => {
        // Long 1 BTC @ 50000, mark at 49000 → PnL = (49000-50000)*1 = -1000
        expect(calculatePositionUnrealizedPnl('1', '50000', '49000')).toBe('-1000');
      });

      it('handles fractional sizes', () => {
        // Long 0.5 BTC @ 50000, mark at 52000 → PnL = (52000-50000)*0.5 = 1000
        expect(calculatePositionUnrealizedPnl('0.5', '50000', '52000')).toBe('1000');
      });

      it('returns 0 when mark equals entry', () => {
        expect(calculatePositionUnrealizedPnl('1', '50000', '50000')).toBe('0');
      });
    });

    describe('short positions (szi < 0)', () => {
      it('calculates profit when price goes down', () => {
        // Short 1 BTC @ 50000, mark at 49000 → PnL = (50000-49000)*1 = 1000
        expect(calculatePositionUnrealizedPnl('-1', '50000', '49000')).toBe('1000');
      });

      it('calculates loss when price goes up', () => {
        // Short 1 BTC @ 50000, mark at 51000 → PnL = (50000-51000)*1 = -1000
        expect(calculatePositionUnrealizedPnl('-1', '50000', '51000')).toBe('-1000');
      });

      it('handles fractional short sizes', () => {
        // Short 2.5 ETH @ 3000, mark at 2800 → PnL = (3000-2800)*2.5 = 500
        expect(calculatePositionUnrealizedPnl('-2.5', '3000', '2800')).toBe('500');
      });
    });

    describe('realistic trading scenarios', () => {
      it('large BTC long with small price movement', () => {
        // Long 10 BTC @ 97500, mark at 97510
        const pnl = calculatePositionUnrealizedPnl('10', '97500', '97510');
        expect(pnl).toBe('100');
      });

      it('small ETH short with big price drop', () => {
        // Short 0.1 ETH @ 3500, mark at 3000
        const pnl = calculatePositionUnrealizedPnl('-0.1', '3500', '3000');
        expect(pnl).toBe('50');
      });
    });
  });

  describe('calculateLiquidationPrice', () => {
    it('returns null for zero position', () => {
      expect(calculateLiquidationPrice('0', '50000', '100000', 20, false)).toBeNull();
    });

    describe('isolated long positions', () => {
      it('calculates liquidation price for a long', () => {
        // Long 1 BTC @ 50000, 20x isolated: margin 2500, maint rate 1/40 (no tiers → 1/(2·lev)).
        // Liquidation is where equity meets maintenance: 2500 + (p − 50000) = 0.025·p
        //   → p = 47500 / 0.975 = 48717.948…
        const liqPx = calculateLiquidationPrice('1', '50000', '100000', 20, false)!;
        expect(Number(liqPx)).toBeCloseTo(48717.9487, 3);
        const equity = 2500 + (Number(liqPx) - 50000);
        expect(equity).toBeCloseTo(Number(liqPx) * 0.025, 6);
      });

      it('liquidation is closer to entry with higher leverage', () => {
        const liq10x = calculateLiquidationPrice('1', '50000', '100000', 10, false);
        const liq50x = calculateLiquidationPrice('1', '50000', '100000', 50, false);
        expect(Number(liq50x)).toBeGreaterThan(Number(liq10x!));
      });

      it('does not return negative liquidation price', () => {
        const liqPx = calculateLiquidationPrice('1', '100', '100000', 1, false);
        expect(Number(liqPx)).toBeGreaterThanOrEqual(0);
      });
    });

    describe('isolated short positions', () => {
      it('calculates liquidation price for a short', () => {
        // Short 1 @ 50000, 20x isolated: 2500 + (50000 − p) = 0.025·p → p = 52500 / 1.025
        const liqPx = calculateLiquidationPrice('-1', '50000', '100000', 20, false)!;
        expect(Number(liqPx)).toBeCloseTo(51219.5122, 3);
        expect(2500 + (50000 - Number(liqPx))).toBeCloseTo(Number(liqPx) * 0.025, 6);
      });

      it('liquidation is closer to entry with higher leverage', () => {
        const liq10x = calculateLiquidationPrice('-1', '50000', '100000', 10, false);
        const liq50x = calculateLiquidationPrice('-1', '50000', '100000', 50, false);
        expect(Number(liq50x)).toBeLessThan(Number(liq10x!));
      });
    });

    describe('isolated leverage edge cases', () => {
      it('1x long can never be liquidated: equity p always ≥ maintenance 0.5·p → liq line at 0', () => {
        // margin 50000 + (p − 50000) = p, maintenance = 0.5·p — equity never falls below it.
        const liqPx = calculateLiquidationPrice('1', '50000', '100000', 1, false);
        expect(liqPx).toBe('0');
      });

      it('200x leverage: very tight liquidation', () => {
        const liqPx = calculateLiquidationPrice('1', '50000', '100000', 200, false);
        expect(Number(liqPx)).toBeGreaterThan(49800);
        expect(Number(liqPx)).toBeLessThan(50000);
      });
    });

    describe('cross-margin null behaviour (HL prod parity)', () => {
      // Modeled on the captured HL prod response 2026-05-09 for an
      // 8 XRP long @ 1.4161 with $144 account value, 5x cross — HL
      // returned `liquidationPx: null` because cushion exceeded notional.
      it('returns null when cushion exceeds notional (long)', () => {
        const liqPx = calculateLiquidationPrice('8', '1.4161', '144', 5, true);
        expect(liqPx).toBeNull();
      });

      it('returns null when cushion exceeds notional (short)', () => {
        const liqPx = calculateLiquidationPrice('-8', '1.4161', '144', 5, true);
        expect(liqPx).toBeNull();
      });

      // Sanity: a cross position with thin-but-positive cushion still
      // gets a price. 100 units @ $50 with $1000 account value:
      //   notional=5000, maintMargin=500, cushion=500 (< notional ✓),
      //   offset=500/100=5, liqPx_long = 50 − 5 = 45.
      it('returns a finite price when cushion is thin (long)', () => {
        const liqPx = calculateLiquidationPrice('100', '50', '1000', 5, true);
        expect(liqPx).not.toBeNull();
        expect(Number(liqPx)).toBeLessThan(50);
        expect(Number(liqPx)).toBeGreaterThan(0);
      });
    });
  });
});
