import type { EventEmitter } from 'node:events';
import { eq, sql } from 'drizzle-orm';
import { id as keccakId } from 'ethers';
import { db } from './db.js';
import { users, orders, fills, consentRecords, funding, ledgerUpdates } from './schema.js';
import { logger } from '../utils/logger.js';
import type { PaperOrder, PaperFill } from '../types/order.js';

// HL emits an all-zero hash for funding rows.
const ZERO_HASH = '0x' + '0'.repeat(64);

let writeQueue: Promise<void> = Promise.resolve();

// Captured in startPgSink so the record* helpers can push WS events for
// userFundings / userNonFundingLedgerUpdates / userEvents without importing
// the worker module (avoids an import cycle).
let bus: EventEmitter | null = null;

function enqueueWrite(task: () => Promise<void>): void {
  writeQueue = writeQueue
    .then(task)
    .catch((err) => {
      logger.error({ err }, 'pg-sink: queued write failed');
    });
}

/** Make sure Redis seq:tid and seq:oid are AHEAD of the PG `fills.tid`
 *  / `orders.oid` maxima. If Redis is flushed (or never seeded) while PG
 *  retains old rows, the next-generated tid/oid will collide with an
 *  existing PG row from any prior user — and `ON CONFLICT DO NOTHING`
 *  in the fill/order sinks below silently drops the new row, so the user
 *  ends up with a position visible in Redis but invisible in PG-backed
 *  endpoints (`/info userFills`, `/info historicalOrders`). Bump the
 *  counters at startup so newly-generated ids are always safe.
 *  +1000 cushion absorbs any in-flight orders between this sync and the
 *  first new placement. */
async function syncSeqCountersToPgMax(): Promise<void> {
  // Lazy redis import to avoid pulling the store module before main()
  // calls connectRedis().
  const { redis } = await import('./redis.js');
  const { KEYS } = await import('./keys.js');
  // db.execute needs a drizzle `sql` tagged query (it calls query.getSQL());
  // a plain { sql, params } object throws "query.getSQL is not a function".
  const [maxFillRow] = await db
    .execute<{ max: number | null }>(sql`SELECT COALESCE(MAX(tid), 0) AS max FROM fills`)
    .catch(() => [{ max: 0 }]);
  const [maxOrderRow] = await db
    .execute<{ max: number | null }>(sql`SELECT COALESCE(MAX(oid), 0) AS max FROM orders`)
    .catch(() => [{ max: 0 }]);
  const pgMaxTid = Number(maxFillRow?.max ?? 0);
  const pgMaxOid = Number(maxOrderRow?.max ?? 0);
  const safeTid = pgMaxTid + 1000;
  const safeOid = pgMaxOid + 1000;
  const redisTid = Number((await redis.get(KEYS.SEQ_TID)) ?? '0');
  const redisOid = Number((await redis.get(KEYS.SEQ_OID)) ?? '0');
  if (redisTid < safeTid) {
    await redis.set(KEYS.SEQ_TID, String(safeTid));
    logger.warn({ redisTid, pgMaxTid, bumpedTo: safeTid }, 'pg-sink: Redis seq:tid was behind PG max — bumped to avoid id collisions');
  }
  if (redisOid < safeOid) {
    await redis.set(KEYS.SEQ_OID, String(safeOid));
    logger.warn({ redisOid, pgMaxOid, bumpedTo: safeOid }, 'pg-sink: Redis seq:oid was behind PG max — bumped to avoid id collisions');
  }
}

export function startPgSink(eventBus: EventEmitter): void {
  bus = eventBus;
  void syncSeqCountersToPgMax().catch((err) => {
    logger.error({ err }, 'pg-sink: syncSeqCountersToPgMax failed (continuing)');
  });
  eventBus.on('fill', (event: { userId: string; fill: PaperFill }) => {
    enqueueWrite(async () => {
      await db.insert(fills)
        .values({
          tid: event.fill.tid,
          userId: event.userId,
          oid: event.fill.oid,
          coin: event.fill.coin,
          px: event.fill.px,
          sz: event.fill.sz,
          side: event.fill.side,
          time: event.fill.time,
          startPosition: event.fill.startPosition,
          dir: event.fill.dir,
          closedPnl: event.fill.closedPnl,
          hash: event.fill.hash,
          crossed: event.fill.crossed,
          fee: event.fill.fee,
          cloid: event.fill.cloid ?? null,
          feeToken: event.fill.feeToken,
        })
        .onConflictDoNothing({ target: fills.tid });
    });
  });

  eventBus.on('orderUpdate', (event: { userId: string; order: PaperOrder; status: string }) => {
    const o = event.order;
    enqueueWrite(async () => {
      await db.insert(orders)
        .values({
          oid: o.oid,
          cloid: o.cloid ?? null,
          userId: o.userId,
          asset: o.asset,
          coin: o.coin,
          isBuy: o.isBuy,
          sz: o.sz,
          limitPx: o.limitPx,
          orderType: o.orderType,
          tif: o.tif,
          reduceOnly: o.reduceOnly,
          triggerPx: o.triggerPx ?? null,
          tpsl: o.tpsl ?? null,
          isMarket: o.isMarket ?? null,
          grouping: o.grouping,
          status: o.status,
          filledSz: o.filledSz,
          avgPx: o.avgPx,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
        })
        .onConflictDoUpdate({
          target: orders.oid,
          set: {
            status: o.status,
            filledSz: o.filledSz,
            avgPx: o.avgPx,
            updatedAt: o.updatedAt,
          },
        });
    });
  });

  logger.info('pg-sink listeners attached');
}

/** Record a funding payment (→ /info userFunding). usdc is the signed
 *  account delta (negative = the user paid funding). */
export function recordFunding(userId: string, r: {
  time: number; coin: string; usdc: string; szi: string; fundingRate: string; nSamples: number;
}): void {
  enqueueWrite(async () => {
    await db.insert(funding).values({
      userId, time: r.time, coin: r.coin, usdc: r.usdc, szi: r.szi,
      fundingRate: r.fundingRate, nSamples: r.nSamples, hash: ZERO_HASH,
    });
  });
  // WS userFundings / userEvents stream this. The WS funding element is FLAT
  // (no hash/delta wrapper, unlike /info userFunding).
  bus?.emit('funding', { userId, funding: r });
}

/** Record a non-funding balance change (→ /info userNonFundingLedgerUpdates).
 *  Paper emits 'deposit' on account creation + balance top-ups, 'withdraw'
 *  on decreases. Hash is synthesized deterministically (paper has no chain). */
export function recordLedgerUpdate(userId: string, r: {
  time: number; deltaType: 'deposit' | 'withdraw'; usdc: string;
}): void {
  const hash = keccakId(`${userId}:${r.time}:${r.deltaType}:${r.usdc}`);
  enqueueWrite(async () => {
    await db.insert(ledgerUpdates).values({
      userId, time: r.time, hash, deltaType: r.deltaType, usdc: r.usdc,
    });
  });
  // WS userNonFundingLedgerUpdates streams the /info-shaped element.
  bus?.emit('ledger', { userId, update: { time: r.time, hash, delta: { type: r.deltaType, usdc: r.usdc } } });
}

export function upsertUser(userId: string, balance: string): void {
  enqueueWrite(async () => {
    await db.insert(users)
      .values({ userId, balance, createdAt: Date.now() })
      .onConflictDoUpdate({
        target: users.userId,
        set: { balance },
      });
  });
}

export function updateUserBalance(userId: string, balance: string): void {
  enqueueWrite(async () => {
    await db.update(users)
      .set({ balance })
      .where(eq(users.userId, userId));
  });
}

/** Fire-and-forget consent-record insert. Drops `id` collisions
 *  silently (same-ms inserts are rare and re-prompting would be more
 *  annoying than missing one audit row). */
export function recordConsent(record: {
  id: number;
  ts: number;
  ipHash: string | null;
  userAgent: string | null;
  policyVersion: number;
  analytics: boolean;
  advertising: boolean;
  adPersonalization: boolean;
}): void {
  enqueueWrite(async () => {
    await db.insert(consentRecords).values(record).onConflictDoNothing();
  });
}
