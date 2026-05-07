import { desc, eq, and, gte, lte } from 'drizzle-orm';
import { db } from './db.js';
import { fills, orders } from './schema.js';
import type { PaperFill } from '../types/order.js';

/** Order in the shape HL's /info historicalOrders returns. */
export interface HistoricalOrder {
  order: {
    coin: string;
    side: 'A' | 'B';
    limitPx: string;
    sz: string;
    oid: number;
    timestamp: number;
    origSz: string;
    orderType: string;
    tif: string | null;
    reduceOnly: boolean;
    cloid: string | null;
    triggerCondition: string;
    isTrigger: boolean;
    triggerPx: string;
    children: never[];
    isPositionTpsl: boolean;
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

  return rows.map((r) => ({
    order: {
      coin: r.coin,
      side: r.isBuy ? 'B' : 'A',
      limitPx: r.limitPx,
      sz: r.sz,
      oid: r.oid,
      timestamp: r.createdAt,
      origSz: r.sz,
      orderType: r.orderType,
      tif: r.tif,
      reduceOnly: r.reduceOnly,
      cloid: r.cloid,
      triggerCondition: 'N/A',
      isTrigger: !!r.triggerPx,
      triggerPx: r.triggerPx ?? '0.0',
      children: [],
      isPositionTpsl: false,
    },
    // HyPaper stores 'cancelled' (UK); HL public uses 'canceled' (US).
    // Normalize so frontend code matching either tree-shakes to one path.
    status: r.status === 'cancelled' ? 'canceled' : r.status,
    statusTimestamp: r.updatedAt,
  }));
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
  };
}
