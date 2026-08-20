/**
 * Real Hyperliquid tiered maintenance-margin math.
 *
 * Replaces the `1 / (2 × leverage)` approximation that was duplicated
 * across position.ts (crossMaintenanceMarginUsed), margin.ts
 * (calculateLiquidationPrice's cross branch), and liquidation.ts
 * (computeMaintenanceMargin) with HL's actual per-tier formula:
 *
 *   maintenance_margin_rate(tier n) = (1 / maxLeverage of tier n) / 2
 *   maintenance_deduction(tier n)   = maintenance_deduction(tier n-1)
 *     + lowerBound(tier n) × (rate(tier n) − rate(tier n-1))
 *   maintenance_margin = notional × rate(tier) − maintenance_deduction(tier)
 *
 * Verified 2026-07 against two live HL testnet accounts — matched HL's real
 * `crossMaintenanceMarginUsed` to 6 decimal places both times. Full
 * derivation + raw JSON in the hl-cross-maintenance-margin.md research doc
 * attached to this task.
 *
 * Every function here is a pure calculation over an already-loaded HlMeta
 * (or a plain tier list) — no Redis/DB access — so callers control where
 * the data comes from and this module stays trivially unit-testable.
 */

import { div, mul, add, sub, gt, gte } from '../utils/math.js';
import type { HlMeta, HlMarginTier } from '../types/hl.js';

/**
 * Resolve the tier list for `coin` from a loaded HlMeta blob.
 *
 * Returns `null` only when the coin isn't found in `meta.universe` at all
 * (or `meta` itself is null) — callers should fall back to a leverage-based
 * synthetic tier in that case so behaviour degrades gracefully instead of
 * throwing. When the asset IS found but has no `marginTableId` (or the id
 * isn't present in `meta.marginTables`), this returns a synthetic flat
 * single tier at the asset's listed `maxLeverage` — that's the correct real
 * behaviour (HL assets without a tiered table are just flat-rate), not a
 * fallback.
 */
export function getMarginTiersForCoin(meta: HlMeta | null, coin: string): HlMarginTier[] | null {
  if (!meta) return null;
  const asset = meta.universe.find((u) => u.name === coin);
  if (!asset) return null;

  if (asset.marginTableId != null && meta.marginTables) {
    const entry = meta.marginTables.find(([id]) => id === asset.marginTableId);
    if (entry) return entry[1].marginTiers;
  }
  return [{ lowerBound: '0.0', maxLeverage: asset.maxLeverage }];
}

/** Which tier a given notional size falls into. Tiers must be ascending by
 *  `lowerBound` (HL's wire format always is). */
function tierForNotional(tiers: HlMarginTier[], notional: string): { tier: HlMarginTier; index: number } {
  let chosen = tiers[0];
  let idx = 0;
  for (let i = 0; i < tiers.length; i++) {
    if (gte(notional, tiers[i].lowerBound)) {
      chosen = tiers[i];
      idx = i;
    } else {
      break;
    }
  }
  return { tier: chosen, index: idx };
}

function rateForTier(tier: HlMarginTier): string {
  // (1 / maxLeverage) / 2 — HL's published maintenance-margin-rate formula.
  return div(div('1', tier.maxLeverage.toString()), '2');
}

/** The maintenance margin RATE that applies to a position of this notional
 *  size (just the tier's rate — does not fold in the deduction term).
 *  Exposed mainly for logging/debugging; use `maintenanceMarginForNotional`
 *  for the actual USD amount owed. */
export function maintenanceMarginRateForNotional(tiers: HlMarginTier[], notional: string): string {
  const { tier } = tierForNotional(tiers, notional);
  return rateForTier(tier);
}

/**
 * The maintenance margin in USD for a position with this notional value,
 * using HL's real tiered formula (rate × notional, minus the deduction term
 * that keeps the total continuous across tier boundaries).
 *
 * For every position we've verified so far (both stay in tier 0), the
 * deduction term is 0 and this collapses to `notional × rate` — matching
 * HL exactly. The tier-boundary-crossing case is implemented per HL's
 * published formula but not yet verified against a real large position
 * (documented as an open item in hl-cross-maintenance-margin.md).
 */
export function maintenanceMarginForNotional(tiers: HlMarginTier[], notional: string): string {
  if (!tiers || tiers.length === 0) return '0';
  const { tier, index } = tierForNotional(tiers, notional);
  const rate = rateForTier(tier);

  let deduction = '0';
  for (let i = 1; i <= index; i++) {
    const prevRate = rateForTier(tiers[i - 1]);
    const curRate = rateForTier(tiers[i]);
    const step = mul(tiers[i].lowerBound, sub(curRate, prevRate));
    deduction = add(deduction, step);
  }

  const raw = sub(mul(notional, rate), deduction);
  return gt(raw, '0') ? raw : '0';
}