import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { D, add, sub, mul, div, abs, gt, gte, lt, lte, isZero, neg } from '../utils/math.js';

export async function calculateAccountValue(userId: string): Promise<string> {
  const balance = await getBalance(userId);
  const unrealizedPnl = await calculateTotalUnrealizedPnl(userId);
  return add(balance, unrealizedPnl);
}

export async function getBalance(userId: string): Promise<string> {
  const balance = await redis.hget(KEYS.USER_ACCOUNT(userId), 'balance');
  return balance ?? '0';
}

export async function calculateTotalUnrealizedPnl(userId: string): Promise<string> {
  const positionAssets = await redis.smembers(KEYS.USER_POSITIONS(userId));
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

export async function calculateTotalMarginUsed(userId: string): Promise<string> {
  const positionAssets = await redis.smembers(KEYS.USER_POSITIONS(userId));
  if (positionAssets.length === 0) return '0';

  const mids = await redis.hgetall(KEYS.MARKET_MIDS);
  let totalMargin = '0';

  for (const assetStr of positionAssets) {
    const asset = parseInt(assetStr, 10);
    const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
    if (!pos.szi || isZero(pos.szi)) continue;

    const midPx = mids[pos.coin];
    if (!midPx) continue;

    const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
    const leverage = lev.leverage ? parseInt(lev.leverage, 10) : 20;

    const posValue = mul(abs(pos.szi), midPx);
    const margin = div(posValue, leverage.toString());
    totalMargin = add(totalMargin, margin);
  }

  return totalMargin;
}

export async function calculatePositionMarginUsed(
  userId: string,
  asset: number,
  szi: string,
  markPx: string,
): Promise<string> {
  if (isZero(szi)) return '0';
  const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
  const leverage = lev.leverage ? parseInt(lev.leverage, 10) : 20;
  const posValue = mul(abs(szi), markPx);
  return div(posValue, leverage.toString());
}

export async function checkMarginForOrder(
  userId: string,
  asset: number,
  isBuy: boolean,
  sz: string,
  px: string,
): Promise<boolean> {
  const accountValue = await calculateAccountValue(userId);
  const currentMarginUsed = await calculateTotalMarginUsed(userId);
  const available = sub(accountValue, currentMarginUsed);

  // Calculate margin needed for this order
  const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
  const leverage = lev.leverage ? parseInt(lev.leverage, 10) : 20;

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
 *  - **Isolated**: dedicated margin per position; never null. Same formula
 *    HyPaper used historically: `entryPx × (1 − 1/leverage + maintRate)`
 *    for longs, mirrored for shorts. The `accountValue` arg is ignored
 *    in this branch, matching how isolated positions don't share equity.
 *
 *  Maintenance margin rate is approximated as `1 / (2 × leverage)` — same
 *  approximation HyPaper has always used. The real HL rate is per-asset
 *  tier-based; this is close enough for paper trading. */
export function calculateLiquidationPrice(
  szi: string,
  entryPx: string,
  accountValue: string,
  leverage: number,
  isCross: boolean,
): string | null {
  if (isZero(szi)) return null;

  const isLong = gt(szi, '0');
  const size = abs(szi);
  const maintMarginRate = div('1', (leverage * 2).toString());

  if (isCross) {
    const positionNotional = mul(size, entryPx);
    const maintMargin = mul(positionNotional, maintMarginRate);
    const cushion = sub(accountValue, maintMargin);
    // If cushion ≥ positionNotional, the account can absorb the position
    // going to zero (long) or doubling (short) without liquidating.
    // HL returns null in those cases — match that.
    if (gte(cushion, positionNotional)) return null;
    if (lte(cushion, '0')) return isLong ? '0' : entryPx;
    const offset = div(cushion, size);
    return isLong ? sub(entryPx, offset) : add(entryPx, offset);
  }

  // Isolated.
  if (isLong) {
    const liqPx = mul(entryPx, sub('1', sub(div('1', leverage.toString()), maintMarginRate)));
    return gt(liqPx, '0') ? liqPx : '0';
  }
  return mul(entryPx, add('1', sub(div('1', leverage.toString()), maintMarginRate)));
}
