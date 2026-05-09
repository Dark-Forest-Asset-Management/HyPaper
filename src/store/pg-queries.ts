import { desc, eq, and, gte, lte } from 'drizzle-orm';
import { db } from './db.js';
import { fills, orders } from './schema.js';
import type { PaperFill } from '../types/order.js';
import { hlTriggerConditionString, hlOrderTypeString } from '../engine/position.js';

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
    // HL prod always emits twapId (null for non-TWAP fills, which is
    // every paper fill since HyPaper has no TWAP path).
    twapId: null,
  };
}
