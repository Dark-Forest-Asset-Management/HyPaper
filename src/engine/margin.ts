import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { D, add, sub, mul, div, abs, gt, gte, lt, lte, isZero, neg } from '../utils/math.js';
import { maintenanceMarginForNotional, maintenanceMarginRateForNotional } from './marginTiers.js';
import { getLeverageSetting } from './assetMeta.js';
import type { HlMarginTier } from '../types/hl.js';

// ── Per-dex scope ─────────────────────────────────────────────────────────
// All public margin/account funcs accept an optional `scope` (dex name, or
// '' for native). Scope=='' keeps the legacy unscoped keys → existing on-disk
// state untouched. Sub-dex scopes use `balance:${scope}` field + scoped
// USER_POSITIONS_SCOPED set. HL semantics: each sub-dex is its own subaccount.

export async function calculateAccountValue(userId: string, scope = ''): Promise<string> {
  const balance = await getBalance(userId, scope);
  const unrealizedPnl = await calculateTotalUnrealizedPnl(userId, scope);
  return add(balance, unrealizedPnl);
}

export async function getBalance(userId: string, scope = ''): Promise<string> {
  const balance = await redis.hget(KEYS.USER_ACCOUNT(userId), KEYS.USER_BAL_FIELD(scope));
  return balance ?? '0';
}

export async function calculateTotalUnrealizedPnl(userId: string, scope = ''): Promise<string> {
  const positionAssets = await redis.smembers(KEYS.USER_POSITIONS_SCOPED(userId, scope));
  if (positionAssets.length === 0) return '0';

  const mids = await redis.hgetall(KEYS.MARKET_MIDS);
  let totalPnl = '0';

  for (const assetStr of positionAssets) {
    const asset = parseInt(assetStr, 10);
    const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
    if (!pos.szi || isZero(pos.szi)) continue;

    const midPx = mids[pos.coin];
    if (!midPx) continue;

    const pnl = calculatePositionUnrealizedPnl(pos.szi, pos.entryPx, midPx);
    totalPnl = add(totalPnl, pnl);
  }

  return totalPnl;
}

export function calculatePositionUnrealizedPnl(szi: string, entryPx: string, markPx: string): string {
  if (isZero(szi)) return '0';
  const isLong = gt(szi, '0');
  const size = abs(szi);
  if (isLong) {
    return mul(sub(markPx, entryPx), size);
  } else {
    return mul(sub(entryPx, markPx), size);
  }
}

export async function calculateTotalMarginUsed(userId: string, scope = ''): Promise<string> {
  const positionAssets = await redis.smembers(KEYS.USER_POSITIONS_SCOPED(userId, scope));
  if (positionAssets.length === 0) return '0';

  const mids = await redis.hgetall(KEYS.MARKET_MIDS);
  let totalMargin = '0';

  for (const assetStr of positionAssets) {
    const asset = parseInt(assetStr, 10);
    const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
    if (!pos.szi || isZero(pos.szi)) continue;

    const midPx = mids[pos.coin];
    if (!midPx) continue;

    const margin = await calculatePositionMarginUsed(userId, asset, pos.szi, midPx);
    totalMargin = add(totalMargin, margin);
  }

  return totalMargin;
}

/** The margin dedicated to an ISOLATED position: the allocation made when it
 *  was opened/grown (`marginAlloc`, written by the matcher — HL: "The margin
 *  required to open a position is position_size * mark_price / leverage",
 *  and "Margin is proportionally removed as the position is closed"), plus
 *  margin the user added/removed via updateIsolatedMargin (`rawUsd`).
 *
 *  It does NOT move with the mark. It used to be recomputed as
 *  size × mark / leverage on every read, which grew the cushion as price rose
 *  and shrank it as price fell, on top of the PnL already counted.
 *  Positions opened before marginAlloc existed fall back to the entry-price
 *  allocation, which is what the matcher would have written. */
export function isolatedMarginOf(pos: Record<string, string>, leverage: number): string {
  const alloc = pos.marginAlloc ?? div(mul(abs(pos.szi ?? '0'), pos.entryPx ?? '0'), leverage.toString());
  return add(alloc, pos.rawUsd ?? '0');
}

export async function calculatePositionMarginUsed(
  userId: string,
  asset: number,
  szi: string,
  markPx: string,
): Promise<string> {
  if (isZero(szi)) return '0';
  const { leverage, isCross } = await getLeverageSetting(userId, asset);
  // Cross margin is the shared account cushion, sized off the current mark.
  if (isCross) return div(mul(abs(szi), markPx), leverage.toString());
  const posData = await redis.hgetall(KEYS.USER_POS(userId, asset));
  return isolatedMarginOf({ ...posData, szi }, leverage);
}

export async function checkMarginForOrder(
  userId: string,
  asset: number,
  isBuy: boolean,
  sz: string,
  px: string,
): Promise<boolean> {
  // Sub-dex orders draw from their dex's subaccount, not native.
  const { scopeForAsset } = await import('./order.js');
  const scope = await scopeForAsset(asset);
  const accountValue = await calculateAccountValue(userId, scope);
  const currentMarginUsed = await calculateTotalMarginUsed(userId, scope);
  const available = sub(accountValue, currentMarginUsed);

  // Calculate margin needed for this order
  const { leverage } = await getLeverageSetting(userId, asset);

  // Check if this is reducing an existing position
  const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
  const currentSzi = pos.szi ?? '0';

  if (!isZero(currentSzi)) {
    const isLong = gt(currentSzi, '0');
    const isReducing = (isLong && !isBuy) || (!isLong && isBuy);

    if (isReducing) {
      // Reducing a position doesn't require additional margin
      return true;
    }
  }

  const orderNotional = mul(sz, px);
  const marginNeeded = div(orderNotional, leverage.toString());

  return !lt(available, marginNeeded);
}

/**
 * Largest order size the account can still afford at `px` (free margin × leverage ÷ px), or `null` when the
 * order is not margin-constrained (it reduces an existing position). Used when a trailing stop FIRES: HL fills
 * as much as the margin allows and drops the rest (round 6, T8), rather than all-or-nothing.
 */
export async function maxAffordableOrderSize(
  userId: string,
  asset: number,
  isBuy: boolean,
  px: string,
): Promise<string | null> {
  const { scopeForAsset } = await import('./order.js');
  const scope = await scopeForAsset(asset);
  const accountValue = await calculateAccountValue(userId, scope);
  const currentMarginUsed = await calculateTotalMarginUsed(userId, scope);
  const available = sub(accountValue, currentMarginUsed);

  const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
  const currentSzi = pos.szi ?? '0';
  if (!isZero(currentSzi)) {
    const isLong = gt(currentSzi, '0');
    if ((isLong && !isBuy) || (!isLong && isBuy)) return null; // reducing: no extra margin needed
  }

  const { leverage } = await getLeverageSetting(userId, asset);
  if (!gt(available, '0')) return '0';
  return div(mul(available, leverage.toString()), px);
}

/** Compute the price at which this position would be liquidated, mirroring
 *  HL prod's behaviour. `isCross` controls the formula:
 *
 *  - **Cross**: position survives until total account value falls below
 *    the sum of maintenance margins. Liquidation price is
 *    `entryPx ∓ (accountValue − maintMargin) / size`. If the cushion is
 *    bigger than the position's notional (i.e. liqPx ≤ 0 for longs, or
 *    ≥ 2× entry for shorts), HL returns `null` — verified 2026-05-09
 *    against an 8 XRP long @ 1.4161 with $144 account value and ~$0.28
 *    maintenance margin: cushion ≈ $143.82, offset ≈ $17.98, liqPx_long
 *    ≈ −16.56 → HL prod emits `liquidationPx: null`.
 *
 *  - **Isolated**: the price p where the position's own equity meets its
 *    maintenance margin — margin + size·(p − entry) = size·p·r for a long,
 *    margin + size·(entry − p) = size·p·r for a short — solved exactly:
 *        long:  p = (size·entry − margin) / (size·(1 − r))
 *        short: p = (size·entry + margin) / (size·(1 + r))
 *    `margin` is the position's dedicated isolated margin (isolatedMarginOf);
 *    r is the asset's maintenance rate from `marginTiers` — HL's rate is
 *    half the initial margin at the asset's MAX leverage, not the user's.
 *    The old isolated formula used 1/(2 × the user's leverage), which is
 *    the wrong rate whenever the user's leverage is below the max.
 *    `accountValue` is ignored here, matching how isolated positions don't
 *    share equity.
 *
 *  When `marginTiers` is omitted (meta unavailable), both branches fall back
 *  to the `1 / (2 × leverage)` approximation. */
export function calculateLiquidationPrice(
  szi: string,
  entryPx: string,
  accountValue: string,
  leverage: number,
  isCross: boolean,
  /** Isolated only: the position's dedicated margin (isolatedMarginOf —
   *  allocation at open plus user adjustments). Defaults to the entry-price
   *  allocation size × entry / leverage. Ignored when `isCross`. */
  isolatedMargin?: string,
  /** Real per-tier margin schedule for this asset (from HlMeta.marginTables,
   *  resolved via getMarginTiersForCoin). */
  marginTiers?: HlMarginTier[],
): string | null {
  if (isZero(szi)) return null;

  const isLong = gt(szi, '0');
  const size = abs(szi);
  const positionNotional = mul(size, entryPx);
  const hasTiers = !!marginTiers && marginTiers.length > 0;

  if (isCross) {
    const maintMargin = hasTiers
      ? maintenanceMarginForNotional(marginTiers!, positionNotional)
      : mul(positionNotional, div('1', (leverage * 2).toString())); // fallback: old approximation
    const cushion = sub(accountValue, maintMargin);
    // If cushion ≥ positionNotional, the account can absorb the position
    // going to zero (long) or doubling (short) without liquidating.
    // HL returns null in those cases — match that.
    if (gte(cushion, positionNotional)) return null;
    if (lte(cushion, '0')) return isLong ? '0' : entryPx;
    const offset = div(cushion, size);
    return isLong ? sub(entryPx, offset) : add(entryPx, offset);
  }

  const margin = isolatedMargin ?? div(positionNotional, leverage.toString());
  // Maintenance margin at notional n is n·r − d (tier rate r, deduction d
  // that keeps the schedule continuous). The tier that applies is the one at
  // the notional AT the liquidation price — what the engine checks when the
  // mark gets there — so solve, re-pick the tier at size × p, and repeat
  // until it stops moving (tier schedules have a handful of steps).
  //   long:  margin + size·(p − entry) = size·p·r − d  →  p = (size·entry − margin − d) / (size·(1 − r))
  //   short: margin + size·(entry − p) = size·p·r − d  →  p = (size·entry + margin + d) / (size·(1 + r))
  const solve = (notional: string): string => {
    const rate = hasTiers
      ? maintenanceMarginRateForNotional(marginTiers!, notional)
      : div('1', (leverage * 2).toString());
    const deduction = hasTiers ? sub(mul(notional, rate), maintenanceMarginForNotional(marginTiers!, notional)) : '0';
    return isLong
      ? div(sub(sub(positionNotional, margin), deduction), mul(size, sub('1', rate)))
      : div(add(add(positionNotional, margin), deduction), mul(size, add('1', rate)));
  };
  let liqPx = solve(positionNotional);
  for (let i = 0; i < 8 && hasTiers && gt(liqPx, '0'); i++) {
    const next = solve(mul(size, liqPx));
    if (D(next).eq(D(liqPx))) break;
    liqPx = next;
  }
  if (isLong) return gt(liqPx, '0') ? liqPx : '0';
  return liqPx;
}
