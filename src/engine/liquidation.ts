/**
 * Liquidation engine — core logic.
 *
 * Implements the full 5-phase plan:
 *   1. Data is already in Redis (positions, leverage, mids) — read from there.
 *   2. Equity is calculated via existing margin.ts helpers.
 *   3. Maintenance margin check (this file).
 *   4. Position close execution (this file, calls fill engine).
 *   5. Logging — inserts a LiquidationEvent row into Postgres.
 *
 * Called by LiquidationWorker (worker/liquidation-worker.ts) on every price
 * update. Also exported for unit tests.
 *
 * Key design decisions:
 *   • Unrealized PnL is fetched from the existing margin.ts path — HL API
 *     returns it; HyPaper already computes it the same way.
 *   • Backstop vault disbursements are a no-op; vault only collects proceeds.
 *   • Positions > $100 k USDC: close 20 % first, 30 s sim-time cooldown,
 *     then close remaining 80 %.
 *   • Maintenance margin rate approximation: 1 / (2 × leverage).
 *     Same as margin.ts calculateLiquidationPrice — keeps the two consistent.
 */

import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import { randomBytes } from 'node:crypto';
import {
  calculateAccountValue,
  calculatePositionUnrealizedPnl,
  calculatePositionMarginUsed,
} from './margin.js';
import { creditVault } from './liquidator-vault.js';
import { insertLiquidationEventPg } from '../store/pg-queries.js';
import {
  D,
  abs,
  add,
  sub,
  mul,
  div,
  gt,
  lt,
  isZero,
} from '../utils/math.js';
import type { LiquidationEvent, MaintenanceMarginResult, LiquidationCheckResult } from '../types/liquidation.js';

// ── Maintenance margin rate lookup ────────────────────────────────────────
//
// Real HL uses per-asset tier tables. HyPaper approximates with
//   maintRate = 1 / (2 × maxLeverage)
// which gives the same values documented:
//   40× → 1.25 %,  20× → 2.5 %,  10× → 5 %,  3× → 16.7 %

function maintenanceMarginRate(leverage: number): string {
  // Clamp leverage to at least 1 to avoid divide-by-zero on malformed data.
  const lev = Math.max(1, leverage);
  return div('1', (lev * 2).toString());
}

// ── Public calculation helpers (also used by tests) ───────────────────────

/**
 * Compute the maintenance margin for a single position.
 */
export function computeMaintenanceMargin(
  szi: string,
  markPx: string,
  leverage: number,
): MaintenanceMarginResult {
  const size = abs(szi);
  const positionNotional = mul(size, markPx);
  const rate = maintenanceMarginRate(leverage);
  const maintenanceMargin = mul(positionNotional, rate);
  return { maintenanceMargin, maintenanceMarginRate: rate, positionNotional };
}

/**
 * Check whether a position should be liquidated.
 *
 * Branches on margin type, matching real HL semantics:
 *
 *   • CROSS — the position survives as long as the WHOLE account's equity
 *     (balance + PnL across every position) stays above the total
 *     maintenance margin owed across every cross position. A single small
 *     position can't be liquidated in isolation if the rest of the account
 *     has a large enough cushion — this is intentional and matches HL.
 *
 *   • ISOLATED — completely independent of the rest of the account. Only
 *     the margin specifically allocated to THIS position (marginUsed,
 *     which includes any extra isolated margin added via
 *     updateIsolatedMargin) backs it. The check is:
 *         positionMargin + positionUnrealizedPnl  <  maintenanceMargin
 *     i.e. once this position's own dedicated cushion is eaten through by
 *     its own losses, it liquidates — regardless of how large the rest of
 *     the account's balance is.
 *
 * BUG FIX (2026-06-19): the original version always used the full-account
 * calculateAccountValue() as the equity figure, even for isolated
 * positions. That meant an isolated position with a $50 margin could never
 * trigger if the account's overall balance was large (e.g. $97k), because
 * $97k always compared as "greater than" the ~$25 maintenance margin
 * required — even though the position's OWN $50 cushion had gone to zero.
 * Confirmed via live testnet trace: isolated XRP position, liquidationPx
 * correctly computed as $1.0955, price forced below it, but
 * shouldLiquidate stayed false because accountEquity was $97,093 (whole
 * account) instead of ~$50 (this position's own margin + its PnL).
 */
export async function checkLiquidation(
  userId: string,
  asset: number,
  scope = '',
): Promise<LiquidationCheckResult> {
  const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
  if (!pos.szi || isZero(pos.szi)) {
    return {
      shouldLiquidate: false,
      accountEquity: '0',
      maintenanceMargin: '0',
      shortfall: '0',
    };
  }

  const mids = await redis.hgetall(KEYS.MARKET_MIDS);
  const markPx = mids[pos.coin];
  if (!markPx) {
    return {
      shouldLiquidate: false,
      accountEquity: '0',
      maintenanceMargin: '0',
      shortfall: '0',
    };
  }

  const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
  const leverage = lev.leverage ? parseInt(lev.leverage, 10) : 20;
  const isCross = lev.isCross !== 'false';

  const { maintenanceMargin } = computeMaintenanceMargin(pos.szi, markPx, leverage);

  if (!isCross) {
    // ── Isolated: this position's own margin + its own PnL, nothing else ──
    const positionMargin = await calculatePositionMarginUsed(userId, asset, pos.szi, markPx);
    const positionPnl = calculatePositionUnrealizedPnl(pos.szi, pos.entryPx, markPx);
    const positionEquity = add(positionMargin, positionPnl);

    const shouldLiquidate = lt(positionEquity, maintenanceMargin);
    const shortfall = shouldLiquidate ? sub(maintenanceMargin, positionEquity) : '0';

    return { shouldLiquidate, accountEquity: positionEquity, maintenanceMargin, shortfall };
  }

  // ── Cross: whole-account equity vs this position's maintenance margin ──

  const accountEquity = await calculateAccountValue(userId, scope);

  const shouldLiquidate = lt(accountEquity, maintenanceMargin);
  const shortfall = shouldLiquidate
    ? sub(maintenanceMargin, accountEquity)
    : '0';

  return { shouldLiquidate, accountEquity, maintenanceMargin, shortfall };
}

// ── Partial-liquidation threshold ─────────────────────────────────────────

const PARTIAL_LIQ_THRESHOLD_USDC = '100000'; // $100 k
const PARTIAL_LIQ_PCT = '0.2';               // 20 %
const PARTIAL_LIQ_DELAY_MS = 30_000;         // 30 seconds sim-time

// Track pending second-half closes so the worker doesn't double-schedule.
// Map key: `${userId}:${asset}`, value: timestamp when the 80 % close fires.
const pendingSecondClose = new Map<string, NodeJS.Timeout>();

// ── Liquidation executor ──────────────────────────────────────────────────

/**
 * Execute a liquidation for `userId`/`asset`.
 *
 * Decides full vs partial close, credits the liquidator vault, logs the
 * event to Postgres, and updates Redis account state.
 *
 * Returns `true` if a liquidation was executed, `false` if the position was
 * already flat or the check re-ran and the account recovered.
 */
export async function executeLiquidation(
  userId: string,
  asset: number,
  scope = '',
): Promise<boolean> {
  const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
  if (!pos.szi || isZero(pos.szi)) return false;

  const mids = await redis.hgetall(KEYS.MARKET_MIDS);
  const markPx = mids[pos.coin];
  if (!markPx) return false;

  const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
  const leverage = lev.leverage ? parseInt(lev.leverage, 10) : 20;
  const isCross = lev.isCross !== 'false';

  // Re-check — price may have recovered between the worker tick and now.
  const { shouldLiquidate, accountEquity, maintenanceMargin } =
    await checkLiquidation(userId, asset, scope);
  if (!shouldLiquidate) return false;

  const positionKey = `${userId}:${asset}`;

  // Don't schedule a second close if one is already pending.
  if (pendingSecondClose.has(positionKey)) return false;

  const szi = pos.szi;
  const positionNotional = mul(abs(szi), markPx);
  const isLargePosition = gt(positionNotional, PARTIAL_LIQ_THRESHOLD_USDC);

  logger.info(
    { userId, asset, coin: pos.coin, szi, markPx, accountEquity, maintenanceMargin, isLargePosition },
    'Liquidation triggered',
  );

  if (isLargePosition) {
    // ── Partial: close 20 % now, 80 % after 30 s ──────────────────────────
    const closeSzi20 = mul(abs(szi), PARTIAL_LIQ_PCT);
    const isLong = gt(szi, '0');
    const closeAmt20 = isLong ? closeSzi20 : `-${closeSzi20}`;

    const recovered20 = await closePositionSlice(userId, asset, closeAmt20, markPx, scope);

    await recordLiquidationEvent(userId, asset, pos.coin, closeAmt20, markPx,
      pos.entryPx, leverage, isCross ? 'cross' : 'isolated',
      recovered20, maintenanceMargin, 'partial');

    await creditVault(recovered20);

    // Schedule the 80 % close after 30 s
    const timer = setTimeout(async () => {
      pendingSecondClose.delete(positionKey);
      try {
        // Re-read position — may have been partially filled or closed by user
        const pos2 = await redis.hgetall(KEYS.USER_POS(userId, asset));
        if (!pos2.szi || isZero(pos2.szi)) return;

        const mids2 = await redis.hgetall(KEYS.MARKET_MIDS);
        const markPx2 = mids2[pos2.coin] ?? markPx;

        const recovered80 = await closePositionSlice(userId, asset, pos2.szi, markPx2, scope);

        await recordLiquidationEvent(userId, asset, pos2.coin, pos2.szi, markPx2,
          pos2.entryPx, leverage, isCross ? 'cross' : 'isolated',
          recovered80, '0', 'full');

        await creditVault(recovered80);

        logger.info(
          { userId, asset, coin: pos2.coin, markPx: markPx2, recovered80 },
          'Liquidation: 80 % close complete',
        );
      } catch (err) {
        logger.error({ err, userId, asset }, 'Liquidation: 80 % close failed');
      }
    }, PARTIAL_LIQ_DELAY_MS);

    pendingSecondClose.set(positionKey, timer);

    logger.info(
      { userId, asset, coin: pos.coin, closeSzi20, markPx, recovered20 },
      'Liquidation: 20 % close complete — 80 % scheduled in 30 s',
    );
  } else {
    // ── Full: close 100 % immediately ─────────────────────────────────────
    const recovered = await closePositionSlice(userId, asset, szi, markPx, scope);

    const marginUsed = await calculatePositionMarginUsed(userId, asset, szi, markPx);

    await recordLiquidationEvent(userId, asset, pos.coin, szi, markPx,
      pos.entryPx, leverage, isCross ? 'cross' : 'isolated',
      recovered, marginUsed, 'full');

    await creditVault(recovered);

    logger.info(
      { userId, asset, coin: pos.coin, szi, markPx, recovered },
      'Liquidation: full close complete',
    );
  }

  return true;
}

// ── Internal: close a position slice at mark price ────────────────────────

/**
 * Force-close `closeSzi` units of `asset` at `markPx` for `userId`.
 *
 * This directly mutates Redis position state (like a market fill at markPx)
 * without going through the order book — liquidations skip the queue.
 * Returns the USDC amount recovered (proceeds − original position cost).
 */
async function closePositionSlice(
  userId: string,
  asset: number,
  closeSzi: string,
  markPx: string,
  scope: string,
): Promise<string> {
  const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
  if (!pos.szi || isZero(pos.szi)) return '0';

  const currentSzi = pos.szi;
  const isLong = gt(currentSzi, '0');
  const closeAbs = abs(closeSzi);
  const currentAbs = abs(currentSzi);

  // Clamp close to position size
  const actualCloseAbs = gt(closeAbs, currentAbs) ? currentAbs : closeAbs;

  // PnL on the closed slice
  const closedPnl = calculatePositionUnrealizedPnl(
    isLong ? actualCloseAbs : `-${actualCloseAbs}`,
    pos.entryPx,
    markPx,
  );

  // Margin released on the closed slice
  const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
  const leverage = lev.leverage ? parseInt(lev.leverage, 10) : 20;
  const sliceNotional = mul(actualCloseAbs, markPx);
  const marginReleased = div(sliceNotional, leverage.toString());

  // Amount recovered = margin released + PnL (can be negative = losses)
  const recovered = add(marginReleased, closedPnl);
  const recoveredClamped = gt(recovered, '0') ? recovered : '0';

  // Update position in Redis
  const newSziAbs = sub(currentAbs, actualCloseAbs);
  const pipeline = redis.pipeline();

  if (isZero(newSziAbs)) {
    // Position fully closed — remove it
    pipeline.del(KEYS.USER_POS(userId, asset));
    pipeline.srem(KEYS.USER_POSITIONS_SCOPED(userId, scope), asset.toString());
    pipeline.srem(KEYS.USER_POSITIONS(userId), asset.toString());
  } else {
    // Partially closed — update size
    const newSzi = isLong ? newSziAbs : `-${newSziAbs}`;
    pipeline.hset(KEYS.USER_POS(userId, asset), 'szi', newSzi);
  }

  // Credit recovered amount back to the user's balance
  const balanceField = scope ? `balance:${scope}` : 'balance';
  const currentBalance = (await redis.hget(KEYS.USER_ACCOUNT(userId), balanceField)) ?? '0';
  const newBalance = add(currentBalance, recoveredClamped);
  pipeline.hset(KEYS.USER_ACCOUNT(userId), balanceField, newBalance);

  await pipeline.exec();

  return recoveredClamped;
}

// ── Internal: record liquidation event to Postgres ───────────────────────

async function recordLiquidationEvent(
  userId: string,
  asset: number,
  coin: string,
  szi: string,
  markPx: string,
  entryPx: string,
  leverage: number,
  marginType: 'cross' | 'isolated',
  amountRecovered: string,
  marginLost: string,
  liquidationType: 'full' | 'partial',
): Promise<void> {
  const event: LiquidationEvent = {
    userId,
    asset,
    coin,
    szi,
    markPx,
    entryPx,
    leverage,
    marginType,
    amountRecovered,
    marginLost,
    liquidationType,
    time: Date.now(),
    // Mirrors the 0x-prefixed hex hash format used elsewhere (fills, funding
    // rows) without depending on a project-specific id generator — randomBytes
    // gives a collision-safe unique value with no external dependency.
    hash: `0x${randomBytes(16).toString('hex')}`,
  };

  try {
    await insertLiquidationEventPg(event);
  } catch (err) {
    // Log but don't rethrow — position is already closed.
    logger.error({ err, userId, asset }, 'Failed to persist liquidation event');
  }
}

// ── Scan all open positions for a user and check each ────────────────────

/**
 * Run the full liquidation check + execute pass for all open positions of
 * a single user. Called by the LiquidationWorker on every price tick.
 */
export async function checkAndLiquidateUser(userId: string, scope = ''): Promise<void> {
  const positionAssets = await redis.smembers(KEYS.USER_POSITIONS_SCOPED(userId, scope));
  if (positionAssets.length === 0) return;

  for (const assetStr of positionAssets) {
    const asset = parseInt(assetStr, 10);
    try {
      const result = await checkLiquidation(userId, asset, scope);
      if (result.shouldLiquidate) {
        logger.info(
          { userId, asset, accountEquity: result.accountEquity, maintenanceMargin: result.maintenanceMargin },
          'Liquidation check: flagging position',
        );
        await executeLiquidation(userId, asset, scope);
      }
    } catch (err) {
      logger.error({ err, userId, asset }, 'Error during liquidation check for asset');
    }
  }
}

/**
 * Run liquidation checks across ALL active users.
 * Called by LiquidationWorker on every price update.
 */
export async function checkAndLiquidateAll(): Promise<void> {
  const users = await redis.smembers(KEYS.USERS_ACTIVE);
  for (const userId of users) {
    try {
      await checkAndLiquidateUser(userId);
    } catch (err) {
      logger.error({ err, userId }, 'Error during liquidation check for user');
    }
  }
}
