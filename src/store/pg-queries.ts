import { desc, asc, eq, and, gte, lte, sql, isNotNull } from 'drizzle-orm';
import { db } from './db.js';
import { fills, orders, funding, ledgerUpdates, liquidationEvents, liquidatorVault, twapHistory } from './schema.js';
import type { PaperFill } from '../types/order.js';
import type { LiquidationEvent } from '../types/liquidation.js';
import { hlTriggerConditionString, hlOrderTypeString } from '../engine/position.js';
import { D, mul } from '../utils/math.js';

/** Order in the shape HL's /info historicalOrders returns.
 *  Field order, types, and explicit-null semantics verified 2026-05-09
 *  against HL prod (1188-entry response on the test wallet). */
export interface HistoricalOrder {
  order: {
    coin: string;
    side: 'A' | 'B';
    limitPx: string;
    sz: string;
    oid: number;
    timestamp: number;
    triggerCondition: string;
    isTrigger: boolean;
    triggerPx: string;
    children: never[];
    isPositionTpsl: boolean;
    reduceOnly: boolean;
    orderType: string;
    origSz: string;
    tif: string | null;
    cloid: string | null;
  };
  status: string;
  statusTimestamp: number;
}

export async function getHistoricalOrdersPg(userId: string, limit = 200): Promise<HistoricalOrder[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.updatedAt))
    .limit(limit);

  return rows.map((r) => {
    const isTrigger = r.orderType === 'trigger';
    const triggerPx = r.triggerPx ?? '0.0';
    return {
      // Inner order object: field order matches HL prod exactly so
      // a JSON.stringify on either backend produces byte-identical output
      // for any consumer that doesn't sort keys.
      order: {
        coin: r.coin,
        side: (r.isBuy ? 'B' : 'A') as 'A' | 'B',
        limitPx: r.limitPx,
        sz: r.sz,
        oid: r.oid,
        timestamp: r.createdAt,
        triggerCondition: isTrigger
          ? hlTriggerConditionString(r.tpsl, r.isBuy, triggerPx)
          : 'N/A',
        isTrigger,
        triggerPx,
        children: [] as never[],
        // Read positionTpsl from the stored grouping rather than
        // hardcoding false — HL distinguishes positionTpsl (attached to
        // the position) vs normalTpsl (independent bracket) and emits
        // this flag accordingly.
        isPositionTpsl: r.grouping === 'positionTpsl',
        reduceOnly: r.reduceOnly,
        // Use the HL prose strings ('Stop Market', 'Take Profit Market',
        // 'Limit', etc.). Schema stores the lowercase generic
        // 'limit'|'trigger' — translate via the same helper
        // getFrontendOpenOrders uses.
        orderType: hlOrderTypeString(isTrigger, r.tpsl ?? undefined, r.isMarket === true),
        origSz: r.sz,
        // HL emits `tif: null` for trigger orders. The DB column is
        // notNull, so coerce here.
        tif: isTrigger ? null : r.tif,
        cloid: r.cloid,
      },
      // HyPaper stores 'cancelled' (UK); HL public uses 'canceled' (US).
      status: r.status === 'cancelled' ? 'canceled' : r.status,
      statusTimestamp: r.updatedAt,
    };
  });
}

export async function getUserFillsPg(userId: string, limit = 100): Promise<PaperFill[]> {
  const rows = await db
    .select()
    .from(fills)
    .where(eq(fills.userId, userId))
    .orderBy(desc(fills.time))
    .limit(limit);

  return rows.map(rowToFill);
}

export async function getUserFillsByTimePg(
  userId: string,
  startTime: number,
  endTime?: number,
): Promise<PaperFill[]> {
  const conditions = [eq(fills.userId, userId), gte(fills.time, startTime)];
  if (endTime !== undefined) {
    conditions.push(lte(fills.time, endTime));
  }

  const rows = await db
    .select()
    .from(fills)
    .where(and(...conditions))
    .orderBy(desc(fills.time));

  return rows.map(rowToFill);
}

/** /info userTwapSliceFills — `[{ fill: <userFills-shaped fill>, twapId }]`,
 *  most recent first. Confirmed against HL prod capture (capture 28): the
 *  wrapper carries the real twapId, but the inner fill object ALWAYS has
 *  `twapId: null` — HL never propagates the id into the nested fill.
 *  Capped at 2000 to match HL's documented "at most 2000 most recent" limit. */
export async function getUserTwapSliceFillsPg(
  userId: string,
  limit = 2000,
): Promise<Array<{ fill: PaperFill; twapId: number }>> {
  const rows = await db
    .select()
    .from(fills)
    .where(and(eq(fills.userId, userId), isNotNull(fills.twapId)))
    .orderBy(desc(fills.time))
    .limit(limit);

  // Force inner fill.twapId to null regardless of the DB value — the wrapper
  // object is where the real id lives. Verified against capture 28: every
  // entry has fill.twapId = null and the outer twapId = the real value.
  return rows.map((r) => ({ fill: { ...rowToFill(r), twapId: null }, twapId: r.twapId as number }));
}

/** /info twapHistory — two entries per TWAP (one 'activated' at placement,
 *  one 'terminated' at completion/cancellation), most recent first.
 *  Wire shape confirmed against prod capture (capture 29):
 *
 *  {
 *    time: <seconds>,                 ← eventAt / 1000 (integer seconds)
 *    state: {
 *      coin, user, side, sz,
 *      executedSz, executedNtl,
 *      minutes, reduceOnly, randomize,
 *      timestamp,                     ← placementTimestamp (ms, NOT seconds)
 *    },
 *    status: { status: 'activated' | 'terminated' },
 *    twapId,
 *  }
 *
 *  Note: HL's `time` (outer) is in SECONDS while `state.timestamp` is in
 *  MILLISECONDS — both confirmed by comparing numeric magnitude against
 *  the capture values. */
export async function getTwapHistoryPg(
  userId: string,
  limit = 2000,
): Promise<Array<{
  time: number;
  state: {
    coin: string;
    user: string;
    side: 'B' | 'A';
    sz: string;
    executedSz: string;
    executedNtl: string;
    minutes: number;
    reduceOnly: boolean;
    randomize: boolean;
    timestamp: number;
  };
  status: { status: string };
  twapId: number;
}>> {
  const rows = await db
    .select()
    .from(twapHistory)
    .where(eq(twapHistory.userId, userId))
    .orderBy(desc(twapHistory.eventAt))
    .limit(limit);

  return rows.map((r) => ({
    // HL outer `time` is in seconds (integer division, not rounded).
    time: Math.floor(r.eventAt / 1000),
    state: {
      coin: r.coin,
      user: r.userId,
      side: (r.isBuy ? 'B' : 'A') as 'B' | 'A',
      sz: r.totalSize,
      executedSz: r.executedSize,
      executedNtl: r.executedNtl,
      minutes: r.minutes,
      reduceOnly: r.reduceOnly,
      randomize: r.randomize,
      // state.timestamp is in milliseconds (confirmed by magnitude vs time).
      timestamp: r.placementTimestamp,
    },
    status: { status: r.state },
    twapId: r.twapId,
  }));
}

/** /info userFunding — `{ time, hash, delta: { type, coin, usdc, szi, fundingRate, nSamples } }`,
 *  ascending by time (matches HL). */
export async function getUserFundingPg(
  userId: string, startTime: number, endTime?: number,
): Promise<Array<{ time: number; hash: string; delta: {
  type: 'funding'; coin: string; usdc: string; szi: string; fundingRate: string; nSamples: number;
} }>> {
  const conds = [eq(funding.userId, userId), gte(funding.time, startTime)];
  if (endTime !== undefined) conds.push(lte(funding.time, endTime));
  const rows = await db.select().from(funding).where(and(...conds)).orderBy(asc(funding.time));
  return rows.map((r) => ({
    time: r.time,
    hash: r.hash,
    delta: {
      type: 'funding' as const,
      coin: r.coin,
      usdc: r.usdc,
      szi: r.szi,
      fundingRate: r.fundingRate,
      nSamples: r.nSamples ?? 1,
    },
  }));
}

/** /info userNonFundingLedgerUpdates — `{ time, hash, delta: { type, usdc } }`,
 *  ascending by time. */
export async function getLedgerUpdatesPg(
  userId: string, startTime: number, endTime?: number,
): Promise<Array<{ time: number; hash: string; delta: { type: string; usdc: string } }>> {
  const conds = [eq(ledgerUpdates.userId, userId), gte(ledgerUpdates.time, startTime)];
  if (endTime !== undefined) conds.push(lte(ledgerUpdates.time, endTime));
  const rows = await db.select().from(ledgerUpdates).where(and(...conds)).orderBy(asc(ledgerUpdates.time));
  return rows.map((r) => ({
    time: r.time,
    hash: r.hash,
    delta: { type: r.deltaType, usdc: r.usdc },
  }));
}

/** Net deposits minus withdrawals (for portfolio PnL = accountValue − netDeposits). */
export async function getNetDepositsPg(userId: string): Promise<string> {
  const rows = await db.select().from(ledgerUpdates).where(eq(ledgerUpdates.userId, userId));
  let net = D('0');
  for (const r of rows) {
    net = r.deltaType === 'withdraw' ? net.minus(D(r.usdc)) : net.plus(D(r.usdc));
  }
  return net.toString();
}

/** Sum of fill notional (px×sz) at/after `since`, for portfolio vlm + userFees. */
export async function getVolumeSincePg(userId: string, since: number): Promise<string> {
  const rows = await db.select().from(fills)
    .where(and(eq(fills.userId, userId), gte(fills.time, since)));
  let vlm = D('0');
  for (const r of rows) vlm = vlm.plus(D(mul(r.px, r.sz)));
  return vlm.toString();
}

// ── Liquidation events ───────────────────────────────────────────────────

/** Insert one liquidation event row (full or partial close). */
export async function insertLiquidationEventPg(event: LiquidationEvent): Promise<void> {
  await db.insert(liquidationEvents).values({
    userId: event.userId,
    asset: event.asset,
    coin: event.coin,
    szi: event.szi,
    markPx: event.markPx,
    entryPx: event.entryPx,
    leverage: event.leverage,
    marginType: event.marginType,
    amountRecovered: event.amountRecovered,
    marginLost: event.marginLost,
    liquidationType: event.liquidationType,
    time: event.time,
    hash: event.hash,
  });
}

/** Fetch liquidation history for one user, most recent first. */
export async function getLiquidationEventsPg(userId: string, limit = 100): Promise<LiquidationEvent[]> {
  const rows = await db
    .select()
    .from(liquidationEvents)
    .where(eq(liquidationEvents.userId, userId))
    .orderBy(desc(liquidationEvents.time))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    asset: r.asset,
    coin: r.coin,
    szi: r.szi,
    markPx: r.markPx,
    entryPx: r.entryPx,
    leverage: r.leverage,
    marginType: r.marginType as 'cross' | 'isolated',
    amountRecovered: r.amountRecovered,
    marginLost: r.marginLost,
    liquidationType: r.liquidationType as 'full' | 'partial',
    time: r.time,
    hash: r.hash,
  }));
}

// ── Liquidator vault (Postgres mirror) ────────────────────────────────────
// Redis (liquidator-vault.ts) is the fast-path source of truth; this is a
// durable mirror so vault totals survive a Redis flush. Single row, id=1.

/** Seed the vault row if it doesn't exist yet. Safe to call on every startup. */
export async function ensureVaultRowPg(vaultAddress: string): Promise<void> {
  await db.insert(liquidatorVault)
    .values({ id: 1, vaultAddress, totalCollected: '0', lastUpdated: Date.now() })
    .onConflictDoNothing();
}

/** Add `amount` to the vault's running total and persist. */
export async function creditVaultPg(amount: string): Promise<void> {
  await db.update(liquidatorVault)
    .set({
      totalCollected: sql`${liquidatorVault.totalCollected}::numeric + ${amount}::numeric`,
      lastUpdated: Date.now(),
    })
    .where(eq(liquidatorVault.id, 1));
}

/** Read the current vault totals from Postgres. */
export async function getVaultStatePg(): Promise<{ vaultAddress: string; totalCollected: string; lastUpdated: number } | null> {
  const rows = await db.select().from(liquidatorVault).where(eq(liquidatorVault.id, 1)).limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  return { vaultAddress: r.vaultAddress, totalCollected: r.totalCollected, lastUpdated: r.lastUpdated };
}

function rowToFill(row: typeof fills.$inferSelect): PaperFill {
  return {
    coin: row.coin,
    px: row.px,
    sz: row.sz,
    side: row.side as 'B' | 'A',
    time: row.time,
    startPosition: row.startPosition,
    dir: row.dir,
    closedPnl: row.closedPnl,
    hash: row.hash,
    oid: row.oid,
    crossed: row.crossed,
    fee: row.fee,
    tid: row.tid,
    cloid: row.cloid ?? undefined,
    feeToken: row.feeToken,
    // HL always emits `twapId: null` inside the fill object on every endpoint
    // (userFills, userFillsByTime, userTwapSliceFills) — confirmed from
    // capture 28 where all six entries have fill.twapId = null regardless of
    // whether the fill was part of a TWAP. The real id is only exposed at
    // the wrapper level in userTwapSliceFills ({ fill, twapId }). Hardcoding
    // null here means getUserFillsPg and getUserFillsByTimePg are also correct
    // without any per-callsite override.
    twapId: null,
  };
}