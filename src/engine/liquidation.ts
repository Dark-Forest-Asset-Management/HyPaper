/**
 * Liquidation engine.
 *
 * Follows HL's published rules (docs, Trading → Liquidations / Margining):
 *
 *   • Trigger: "account equity falls below the maintenance margin", using the
 *     MARK price. Maintenance margin is half the initial margin at the asset's
 *     max leverage (per-tier, engine/marginTiers.ts).
 *       – ISOLATED: the position's own dedicated margin + its own PnL vs its
 *         own maintenance margin. The rest of the account is untouched.
 *       – CROSS: the cross account value (balance − isolated margins + cross
 *         PnL) vs the SUM of maintenance margin over every cross position in
 *         that dex. When it trips, every cross position is liquidated.
 *   • Market liquidation: "the system first tries to close the full position
 *     with market orders sent to the book." The trader keeps whatever
 *     collateral remains. Paper closes at the mark, as a taker (fee charged).
 *   • Partial: a liquidatable position above 100k USDC sends only 20% to the
 *     book; then a 30-second cooldown during which "market liquidation orders
 *     for that user cover the entire position".
 *   • Backstop: once equity is below 2/3 of maintenance margin the liquidator
 *     vault takes the position and "the maintenance margin is not returned to
 *     the user". Isolated: that position and its margin transfer. Cross: all
 *     cross positions and cross margin transfer (cross equity ends at zero).
 *
 * Every liquidation close is written the way HL reports it: as a FILL
 * (→ userFills / userFillsByTime / WS userFills + userEvents) carrying
 * `liquidation: { liquidatedUser, markPx, method }`. A backstop also writes
 * the `liquidation` ledger delta (→ userNonFundingLedgerUpdates) and a WS
 * userEvents `liquidation` event. Shapes from public HL, captured 2026-10-19
 * for 0xcb02837caaee310c178501855b63bf7f4f4b1f8b (HMSTR isolated short):
 *   market fills:   dir "Close Short", fee charged, method "market"
 *   backstop fill:  dir "Liquidated Isolated Short", fee "0.0", method "backstop"
 *
 * Before 2026-10-19 a liquidation deleted the position without writing any
 * fill and credited margin + PnL to the balance — where margin had never been
 * deducted — so the trader was paid back their margin while the same amount
 * was credited to the vault, and the position simply vanished from history.
 *
 * Balance model (unchanged): `balance` holds realized cash; margin is a
 * reservation against it, never deducted. So a close credits closedPnl − fee,
 * and a backstop then debits the equity that transfers to the vault.
 */

import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { randomBytes } from 'node:crypto';
import { calculatePositionUnrealizedPnl, isolatedMarginOf, getBalance } from './margin.js';
import { getMarginTiersForCoin, maintenanceMarginForNotional, maintenanceMarginRateForNotional } from './marginTiers.js';
import { getLeverageSetting, loadUniverseEntry, subDexNames } from './assetMeta.js';
import { queueVaultCredit, mirrorVaultCreditPg } from './liquidator-vault.js';
import { getL2Book } from '../utils/l2-cache.js';
import { computeVwap } from '../utils/slippage.js';
import { withUserLock } from '../utils/userLock.js';
import { insertLiquidationEventPg } from '../store/pg-queries.js';
import { getFreshMark } from '../worker/mark-feed.js';
import { nextOid, nextTid } from '../utils/id.js';
import { abs, add, sub, mul, div, gt, lt, isZero, neg, roundToDecimals } from '../utils/math.js';
import type { LiquidationEvent, MaintenanceMarginResult, LiquidationCheckResult } from '../types/liquidation.js';
import type { HlMeta, HlMarginTier } from '../types/hl.js';
import type { PaperFill, PaperOrder } from '../types/order.js';

// ── Maintenance margin ────────────────────────────────────────────────────

/** Fallback when no tier data is cached: 1 / (2 × leverage). */
function maintenanceMarginRate(leverage: number): string {
  // Clamp leverage to at least 1 to avoid divide-by-zero on malformed data.
  const lev = Math.max(1, leverage);
  return div('1', (lev * 2).toString());
}

/**
 * Compute the maintenance margin for a single position.
 *
 * When `marginTiers` is supplied, uses HL's real per-tier formula. When
 * omitted (e.g. no market meta cached yet), falls back to the
 * `1 / (2 × leverage)` approximation.
 */
export function computeMaintenanceMargin(
  szi: string,
  markPx: string,
  leverage: number,
  marginTiers?: HlMarginTier[],
): MaintenanceMarginResult {
  const size = abs(szi);
  const positionNotional = mul(size, markPx);

  if (marginTiers && marginTiers.length > 0) {
    const maintenanceMargin = maintenanceMarginForNotional(marginTiers, positionNotional);
    const rate = maintenanceMarginRateForNotional(marginTiers, positionNotional);
    return { maintenanceMargin, maintenanceMarginRate: rate, positionNotional };
  }

  const rate = maintenanceMarginRate(leverage);
  const maintenanceMargin = mul(positionNotional, rate);
  return { maintenanceMargin, maintenanceMarginRate: rate, positionNotional };
}

// ── Constants (HL docs, Liquidations) ─────────────────────────────────────

const PARTIAL_LIQ_THRESHOLD_USDC = '100000'; // "above 100k USDC" (mainnet)
const PARTIAL_LIQ_PCT = '0.2';               // "only 20% goes to the book"
const PARTIAL_LIQ_COOLDOWN_MS = 30_000;      // "30-second cooldown"
const BACKSTOP_FRACTION = div('2', '3');     // "below 2/3 of maintenance margin"


// ── Position snapshot ─────────────────────────────────────────────────────

interface PositionView {
  asset: number;
  coin: string;
  szi: string;
  entryPx: string;
  /** Price the check runs on: fresh mark, else mid. */
  px: string;
  leverage: number;
  isCross: boolean;
  notional: string;
  pnl: string;
  maintenanceMargin: string;
  /** Isolated only: the position's dedicated margin. */
  isolatedMargin: string;
  raw: Record<string, string>;
}

/** HL liquidates on the MARK. Paper's mark is fresh only for coins with a
 *  live per-coin feed (worker/mark-feed.ts — the liquidation worker requests
 *  one for every coin with an open position); otherwise the mid is used. */
async function priceFor(coin: string, mids: Record<string, string>): Promise<string | undefined> {
  return (await getFreshMark(coin)) ?? mids[coin];
}

async function loadPositions(userId: string, scope: string): Promise<PositionView[]> {
  const assets = await redis.smembers(KEYS.USER_POSITIONS_SCOPED(userId, scope));
  if (assets.length === 0) return [];
  const mids = await redis.hgetall(KEYS.MARKET_MIDS);
  const metaRaw = await redis.get(scope ? KEYS.MARKET_META_DEX(scope) : KEYS.MARKET_META);
  const meta: HlMeta | null = metaRaw ? JSON.parse(metaRaw) : null;

  const out: PositionView[] = [];
  for (const assetStr of assets) {
    const asset = parseInt(assetStr, 10);
    const raw = await redis.hgetall(KEYS.USER_POS(userId, asset));
    if (!raw.szi || isZero(raw.szi)) continue;
    const px = await priceFor(raw.coin, mids);
    if (!px) continue;
    const { leverage, isCross } = await getLeverageSetting(userId, asset);
    // Falls back to a flat tier at the position's own leverage only when
    // meta for the coin isn't cached.
    const tiers = getMarginTiersForCoin(meta, raw.coin) ?? [{ lowerBound: '0.0', maxLeverage: leverage }];
    const { maintenanceMargin, positionNotional } = computeMaintenanceMargin(raw.szi, px, leverage, tiers);
    out.push({
      asset,
      coin: raw.coin,
      szi: raw.szi,
      entryPx: raw.entryPx,
      px,
      leverage,
      isCross,
      notional: positionNotional,
      pnl: calculatePositionUnrealizedPnl(raw.szi, raw.entryPx, px),
      maintenanceMargin,
      isolatedMargin: isCross ? '0' : isolatedMarginOf(raw, leverage),
      raw,
    });
  }
  return out;
}

/** Cross account value for a dex: balance − margin dedicated to isolated
 *  positions + cross unrealized PnL. Isolated equity is excluded both ways —
 *  its margin is reserved, its PnL is its own. */
function crossAccountValue(balance: string, positions: PositionView[]): string {
  let v = balance;
  for (const p of positions) v = p.isCross ? add(v, p.pnl) : sub(v, p.isolatedMargin);
  return v;
}

// ── Check ─────────────────────────────────────────────────────────────────

interface Assessment {
  shouldLiquidate: boolean;
  equity: string;
  maintenanceMargin: string;
  method: 'market' | 'backstop';
  /** The positions this liquidation closes. */
  targets: PositionView[];
}

function assess(equity: string, maintenanceMargin: string, targets: PositionView[]): Assessment {
  const shouldLiquidate = targets.length > 0 && lt(equity, maintenanceMargin);
  const method = lt(equity, mul(maintenanceMargin, BACKSTOP_FRACTION)) ? 'backstop' : 'market';
  return { shouldLiquidate, equity, maintenanceMargin, method, targets };
}

function assessIsolated(p: PositionView): Assessment {
  return assess(add(p.isolatedMargin, p.pnl), p.maintenanceMargin, [p]);
}

function assessCross(balance: string, positions: PositionView[]): Assessment {
  const cross = positions.filter((p) => p.isCross);
  let mm = '0';
  for (const p of cross) mm = add(mm, p.maintenanceMargin);
  return assess(crossAccountValue(balance, positions), mm, cross);
}

/**
 * Should the position on `asset` be liquidated right now? For an isolated
 * position this is that position alone; for a cross position it is the whole
 * cross account of the asset's dex (`accountEquity` = cross account value,
 * `maintenanceMargin` = summed over every cross position).
 */
export async function checkLiquidation(
  userId: string,
  asset: number,
  scope = '',
): Promise<LiquidationCheckResult> {
  const none: LiquidationCheckResult = { shouldLiquidate: false, accountEquity: '0', maintenanceMargin: '0', shortfall: '0' };
  const positions = await loadPositions(userId, scope);
  const p = positions.find((x) => x.asset === asset);
  if (!p) return none;
  const a = p.isCross ? assessCross(await getBalance(userId, scope), positions) : assessIsolated(p);
  return {
    shouldLiquidate: a.shouldLiquidate,
    accountEquity: a.equity,
    maintenanceMargin: a.maintenanceMargin,
    shortfall: a.shouldLiquidate ? sub(a.maintenanceMargin, a.equity) : '0',
  };
}

// ── Execute ───────────────────────────────────────────────────────────────

async function szDecimalsFor(asset: number): Promise<number> {
  const found = await loadUniverseEntry(asset);
  return found ? found.universe[found.localIdx].szDecimals : 8;
}

/** Fill price for a liquidation close. Market: the close is a taker order
 *  into the book, so it walks the real L2 book (public HL, utils/l2-cache.ts)
 *  exactly like a paper market order, falling back to the mark when no book
 *  is available. Backstop: the vault takes the position at the mark. */
async function liquidationFillPx(p: PositionView, sz: string, method: 'market' | 'backstop'): Promise<string> {
  if (method === 'backstop') return p.px;
  const book = await getL2Book(p.coin);
  if (!book) return p.px;
  const isBuy = !gt(p.szi, '0'); // closing a long sells into bids
  return computeVwap(isBuy ? book.levels[1] : book.levels[0], sz, isBuy, null, p.px).fillPx;
}

interface PlannedClose {
  p: PositionView;
  order: PaperOrder;
  fill: PaperFill;
  remaining: string;
}

/** Build one liquidation close (no writes yet). */
async function planClose(
  userId: string,
  p: PositionView,
  closeAbs: string,
  method: 'market' | 'backstop',
  now: number,
): Promise<PlannedClose> {
  const isLong = gt(p.szi, '0');
  const posAbs = abs(p.szi);
  const sz = gt(closeAbs, posAbs) ? posAbs : closeAbs;
  const px = await liquidationFillPx(p, sz, method);
  const closedPnl = calculatePositionUnrealizedPnl(isLong ? sz : neg(sz), p.entryPx, px);
  // A market liquidation is a taker order into the book; the backstop
  // transfer pays no fee (public HL backstop fill: "fee": "0.0").
  const fee = method === 'market' && config.FEES_ENABLED ? mul(mul(sz, px), config.FEE_RATE_TAKER) : '0';
  const dir = method === 'market'
    ? (isLong ? 'Close Long' : 'Close Short')
    : `Liquidated ${p.isCross ? 'Cross' : 'Isolated'} ${isLong ? 'Long' : 'Short'}`;
  const oid = await nextOid();
  const tid = await nextTid();
  const order: PaperOrder = {
    oid, userId, asset: p.asset, coin: p.coin, isBuy: !isLong, sz, limitPx: px,
    orderType: 'limit', tif: 'Ioc', reduceOnly: true, grouping: 'na',
    status: 'filled', filledSz: sz, avgPx: px, createdAt: now, updatedAt: now,
  };
  const fill: PaperFill = {
    coin: p.coin,
    px,
    sz,
    side: isLong ? 'A' : 'B',
    time: now,
    startPosition: p.szi,
    dir,
    closedPnl,
    hash: `0x${tid.toString(16).padStart(64, '0')}`,
    oid,
    crossed: true,
    fee,
    tid,
    // markPx is the mark the liquidation was evaluated on, as on HL.
    liquidation: { liquidatedUser: userId, markPx: p.px, method },
    feeToken: 'USDC',
    twapId: null,
  };
  return { p, order, fill, remaining: sub(posAbs, sz) };
}

/** Queue a planned close's Redis writes: position, balance (closedPnl − fee), fill list. */
function queueClose(pipeline: ReturnType<typeof redis.multi>, userId: string, scope: string, c: PlannedClose): void {
  const { p, fill, remaining } = c;
  const isLong = gt(p.szi, '0');
  const posKey = KEYS.USER_POS(userId, p.asset);
  const balField = KEYS.USER_BAL_FIELD(scope);
  if (isZero(remaining)) {
    pipeline.del(posKey);
    pipeline.srem(KEYS.USER_POSITIONS_SCOPED(userId, scope), p.asset.toString());
    pipeline.srem(KEYS.USER_POSITIONS(userId), p.asset.toString());
  } else {
    pipeline.hset(posKey, 'szi', isLong ? remaining : neg(remaining));
    if (!p.isCross) {
      // "Margin is proportionally removed as the position is closed."
      const keep = div(remaining, abs(p.szi));
      pipeline.hset(posKey, 'marginAlloc', mul(p.raw.marginAlloc ?? div(mul(abs(p.szi), p.entryPx), p.leverage.toString()), keep));
      if (p.raw.rawUsd) pipeline.hset(posKey, 'rawUsd', mul(p.raw.rawUsd, keep));
    }
  }
  if (!isZero(fill.closedPnl)) pipeline.hincrbyfloat(KEYS.USER_ACCOUNT(userId), balField, fill.closedPnl);
  if (!isZero(fill.fee)) pipeline.hincrbyfloat(KEYS.USER_ACCOUNT(userId), balField, neg(fill.fee));
  pipeline.lpush(KEYS.USER_FILLS(userId), JSON.stringify(fill));
}

/** Run one liquidation (all its target positions). Caller holds the user lock. */
async function runLiquidation(userId: string, scope: string, a: Assessment): Promise<boolean> {
  const first = a.targets[0];
  const cooldownKey = KEYS.LIQ_COOLDOWN(`${userId}:${scope}:${first.isCross ? 'cross' : first.asset}`);
  const inCooldown = (await redis.get(cooldownKey)) !== null;
  const now = Date.now();

  logger.info(
    { userId, scope, method: a.method, equity: a.equity, maintenanceMargin: a.maintenanceMargin,
      marginType: first.isCross ? 'cross' : 'isolated', assets: a.targets.map((t) => t.asset), inCooldown },
    'Liquidation triggered',
  );

  let partial = false;
  const closes: PlannedClose[] = [];
  for (const p of a.targets) {
    let closeAbs = abs(p.szi);
    if (a.method === 'market' && !inCooldown && gt(p.notional, PARTIAL_LIQ_THRESHOLD_USDC)) {
      const slice = roundToDecimals(mul(closeAbs, PARTIAL_LIQ_PCT), await szDecimalsFor(p.asset));
      if (gt(slice, '0')) { closeAbs = slice; partial = true; }
    }
    closes.push(await planClose(userId, p, closeAbs, a.method, now));
  }
  if (closes.length === 0) return false;

  // Backstop: the remaining equity of what was liquidated goes to the vault
  // ("the maintenance margin is not returned to the user"). Backstop fills
  // are at the same mark the equity was computed on, so once the closes
  // credit their PnL the debit leaves: isolated → balance down by exactly its
  // margin; cross → cross equity at zero. A negative equity is the vault's
  // loss: the debit is negative (the trader can't lose more than that margin)
  // and the vault is credited nothing.
  const transferred = a.method === 'backstop' ? a.equity : '0';

  // ONE MULTI/EXEC transaction: every close, the backstop debit, the vault
  // credit and the cooldown marker commit together or not at all. (A plain
  // ioredis pipeline only batches — it is not atomic.)
  const pipeline = redis.multi();
  for (const c of closes) queueClose(pipeline, userId, scope, c);
  if (!isZero(transferred)) {
    pipeline.hincrbyfloat(KEYS.USER_ACCOUNT(userId), KEYS.USER_BAL_FIELD(scope), neg(transferred));
  }
  const vaultCredited = queueVaultCredit(pipeline, transferred, now);
  if (partial) pipeline.set(cooldownKey, '1', 'PX', PARTIAL_LIQ_COOLDOWN_MS);
  await pipeline.exec();
  if (vaultCredited) mirrorVaultCreditPg(transferred);

  // Lazy import — the worker module must not be a static dependency of the engine.
  const { eventBus } = await import('../worker/index.js');
  for (const c of closes) {
    eventBus.emit('liquidationOrder', { order: c.order }); // order row first (fills.oid references it)
    eventBus.emit('fill', { userId, fill: c.fill });        // → PG fills, WS userFills + userEvents
    logger.info(
      { userId, asset: c.p.asset, coin: c.p.coin, method: a.method, sz: c.fill.sz, px: c.fill.px,
        closedPnl: c.fill.closedPnl, fee: c.fill.fee, dir: c.fill.dir },
      'Liquidation fill',
    );
  }

  if (a.method === 'backstop') {
    let ntl = '0';
    for (const p of a.targets) ntl = add(ntl, p.notional);
    eventBus.emit('liquidationLedger', {
      userId,
      time: now,
      delta: {
        type: 'liquidation',
        liquidatedNtlPos: ntl,
        accountValue: a.equity,
        leverageType: first.isCross ? 'Cross' : 'Isolated',
        liquidatedPositions: a.targets.map((p) => ({ coin: p.coin, szi: p.szi })),
      },
    });
    // WS userEvents `liquidation` variant (HL docs, websocket subscriptions:
    // WsLiquidation { lid, liquidator, liquidated_user, liquidated_ntl_pos,
    // liquidated_account_value }).
    eventBus.emit('liquidationEvent', {
      userId,
      liquidation: {
        lid: closes[0].fill.tid,
        liquidator: config.LIQUIDATOR_VAULT_ADDRESS,
        liquidated_user: userId,
        liquidated_ntl_pos: ntl,
        liquidated_account_value: a.equity,
      },
    });
  }

  // The positions shrank / closed: orphan any open reduce-only trailing stop that can no longer reduce them.
  if ((await redis.smembers(KEYS.ORDERS_TRAILING)).length > 0) {
    const { reconcileReduceOnlyStops } = await import('./trailing-state.js');
    for (const c of closes) {
      const isLong = gt(c.p.szi, '0');
      const szAfter = isZero(c.remaining) ? '0' : isLong ? c.remaining : neg(c.remaining);
      const orphans = await reconcileReduceOnlyStops(eventBus, userId, c.p.asset, szAfter);
      if (orphans.length > 0) eventBus.emit('orderUpdateBatch', { userId, updates: orphans });
    }
  }

  for (let i = 0; i < closes.length; i++) {
    const { p, fill, remaining } = closes[i];
    await recordLiquidationEvent({
      userId, asset: p.asset, coin: p.coin, szi: fill.sz, markPx: p.px, entryPx: p.entryPx,
      leverage: p.leverage, marginType: p.isCross ? 'cross' : 'isolated',
      amountRecovered: i === 0 ? transferred : '0',
      marginLost: a.method === 'backstop' ? (p.isCross ? p.maintenanceMargin : p.isolatedMargin) : '0',
      liquidationType: isZero(remaining) ? 'full' : 'partial',
      time: fill.time,
    });
  }

  eventBus.emit('accountUpdate', { userId, dexes: scope ? [scope] : [] });
  return true;
}

async function recordLiquidationEvent(e: Omit<LiquidationEvent, 'hash'>): Promise<void> {
  try {
    await insertLiquidationEventPg({ ...e, hash: `0x${randomBytes(16).toString('hex')}` });
  } catch (err) {
    // Log but don't rethrow — position is already closed.
    logger.error({ err, userId: e.userId, asset: e.asset }, 'Failed to persist liquidation event');
  }
}

/**
 * Liquidate whatever `asset`'s position belongs to if it is liquidatable:
 * the isolated position itself, or every cross position in its dex.
 * Assessed and executed under the user's lock (utils/userLock.ts), so no fill
 * can move the position between the check and the close.
 * Returns true if a liquidation ran.
 */
export async function executeLiquidation(userId: string, asset: number, scope = ''): Promise<boolean> {
  return withUserLock(userId, async () => {
    const positions = await loadPositions(userId, scope);
    const p = positions.find((x) => x.asset === asset);
    if (!p) return false;
    const a = p.isCross ? assessCross(await getBalance(userId, scope), positions) : assessIsolated(p);
    if (!a.shouldLiquidate) return false;
    return runLiquidation(userId, scope, a);
  });
}

// ── Scan ──────────────────────────────────────────────────────────────────

/** One liquidation pass over a user's positions in one dex, under the user's
 *  lock: isolated positions first (each on its own), then the cross account —
 *  re-read, since an isolated close returns its remaining margin to cross. */
export async function checkAndLiquidateUser(userId: string, scope = ''): Promise<void> {
  try {
    await withUserLock(userId, async () => {
      for (const p of await loadPositions(userId, scope)) {
        if (p.isCross) continue;
        const a = assessIsolated(p);
        if (a.shouldLiquidate) await runLiquidation(userId, scope, a);
      }
      const positions = await loadPositions(userId, scope);
      if (positions.some((p) => p.isCross)) {
        const a = assessCross(await getBalance(userId, scope), positions);
        if (a.shouldLiquidate) await runLiquidation(userId, scope, a);
      }
    });
  } catch (err) {
    logger.error({ err, userId, scope }, 'Error during liquidation check');
  }
}

/** The (user, dex) accounts holding positions, from KEYS.POSITION_HOLDERS.
 *  Entries whose position set has emptied are pruned here. */
async function positionHolders(): Promise<Array<{ userId: string; scope: string }>> {
  const out: Array<{ userId: string; scope: string }> = [];
  for (const member of await redis.smembers(KEYS.POSITION_HOLDERS)) {
    const bar = member.lastIndexOf('|');
    const userId = member.slice(0, bar);
    const scope = member.slice(bar + 1);
    if ((await redis.scard(KEYS.USER_POSITIONS_SCOPED(userId, scope))) === 0) {
      await redis.srem(KEYS.POSITION_HOLDERS, member);
      continue;
    }
    out.push({ userId, scope });
  }
  return out;
}

/** One-off at worker start: index positions opened before POSITION_HOLDERS
 *  existed (every active user × native + every HIP-3 dex). */
export async function backfillPositionHolders(): Promise<number> {
  const scopes = ['', ...(await subDexNames())];
  let added = 0;
  for (const userId of await redis.smembers(KEYS.USERS_ACTIVE)) {
    for (const scope of scopes) {
      if ((await redis.scard(KEYS.USER_POSITIONS_SCOPED(userId, scope))) > 0) {
        added += await redis.sadd(KEYS.POSITION_HOLDERS, `${userId}|${scope}`);
      }
    }
  }
  return added;
}

/**
 * Run liquidation checks for every account holding a position, on the native
 * dex AND every HIP-3 dex — each dex is its own account on HL. (Only the
 * native dex was ever checked before 2026-10-19, so builder-dex positions
 * could not be liquidated at all.) Called by LiquidationWorker on every price
 * update.
 */
export async function checkAndLiquidateAll(): Promise<void> {
  for (const { userId, scope } of await positionHolders()) await checkAndLiquidateUser(userId, scope);
}

/** Every coin with an open perp position — the liquidation worker keeps a
 *  fresh mark for each. */
export async function positionCoins(): Promise<Set<string>> {
  const coins = new Set<string>();
  for (const { userId, scope } of await positionHolders()) {
    for (const assetStr of await redis.smembers(KEYS.USER_POSITIONS_SCOPED(userId, scope))) {
      const coin = await redis.hget(KEYS.USER_POS(userId, parseInt(assetStr, 10)), 'coin');
      if (coin) coins.add(coin);
    }
  }
  return coins;
}
