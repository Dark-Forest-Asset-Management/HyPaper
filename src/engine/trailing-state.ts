/**
 * Redis-level operations on trailing-stop orders. Shared by the matcher
 * (evaluate / fire / terminate), the cancel path and the info builders.
 *
 * Kept free of any import of worker/index.ts (the event bus is passed in) so
 * the matcher can use it without creating an import cycle.
 *
 * State lives entirely in the order's Redis hash (`order:{oid}`) — the same
 * place as every other order — so it survives a HyPaper restart exactly like
 * resting limit orders do. `best` / `triggerPx` / `limitPx` are written ONLY
 * when they change.
 */

import type { EventEmitter } from 'node:events';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { buildTrailingBody, type TrailingBody, type TrailingEval } from './trailing-math.js';
import { gt, lt } from '../utils/math.js';
import type { PaperOrder, OrderStatus } from '../types/order.js';

/** Persist an evaluation result onto the order hash. Returns true if anything changed. */
export async function persistTrailingEvaluation(
  oid: number,
  data: Record<string, string>,
  ev: TrailingEval,
): Promise<boolean> {
  const next: Record<string, string> = {
    trActivated: ev.state.activated ? 'true' : 'false',
    trBest: ev.state.best ?? '',
    triggerPx: ev.triggerPx ?? '',
    limitPx: ev.limitPx,
  };
  const changed: Record<string, string> = {};
  for (const [k, v] of Object.entries(next)) {
    if ((data[k] ?? '') !== v) changed[k] = v;
  }
  if (Object.keys(changed).length === 0) return false;
  await redis.hset(KEYS.ORDER(oid), changed);
  Object.assign(data, changed);
  return true;
}

/**
 * Freeze the CURRENT live body onto the order (`trSnap`). HL's `orderStatus`
 * serves a frozen snapshot — it does not follow the ratchet — that is
 * refreshed only on status transitions; the same frozen body is what the
 * `triggered` / cancel history rows carry.
 */
export async function freezeTrailingSnapshot(oid: number, data: Record<string, string>): Promise<void> {
  await redis.hset(KEYS.ORDER(oid), 'trSnap', JSON.stringify(buildTrailingBody(data, false)));
}

/**
 * One row of HL's /info historicalOrders for a trailing stop (status + the body
 * FROZEN as of that transition). Persisted append-only by pg-sink into
 * order_status_events.
 */
export interface TrailingHistoryEvent {
  userId: string;
  oid: number;
  /** HL status string: open | triggered | filled | canceled | reduceOnlyCanceled | marginCanceled */
  status: string;
  statusTimestamp: number;
  body: TrailingBody;
}

export function emitTrailingHistory(
  eventBus: EventEmitter,
  data: Record<string, string>,
  status: string,
  statusTimestamp: number,
  body: TrailingBody,
): void {
  const ev: TrailingHistoryEvent = { userId: data.userId, oid: parseInt(data.oid, 10), status, statusTimestamp, body };
  eventBus.emit('trailingHistory', ev);
}

/** Build the PaperOrder shape the event bus / pg-sink expect from an order hash. */
export function paperOrderFromHash(data: Record<string, string>, status: OrderStatus, at: number): PaperOrder {
  return {
    oid: parseInt(data.oid, 10),
    cloid: undefined,
    userId: data.userId,
    asset: parseInt(data.asset, 10),
    coin: data.coin,
    isBuy: data.isBuy === 'true',
    sz: data.sz,
    limitPx: data.limitPx,
    orderType: 'trailingStop',
    tif: 'Gtc',
    reduceOnly: data.reduceOnly === 'true',
    triggerPx: data.triggerPx || undefined,
    grouping: 'na',
    status,
    filledSz: data.filledSz ?? '0',
    avgPx: data.avgPx ?? '0',
    createdAt: parseInt(data.createdAt, 10),
    updatedAt: at,
  };
}

/**
 * End an OPEN trailing stop WITHOUT a fill, with one of HL's status strings
 * (`reduceOnlyCanceled` when the position went flat / flipped,
 * `marginCanceled` when margin is short at fire time). Freezes the live
 * snapshot, flips the status, drops the order from the trailing set and emits
 * the order update. No-op (returns false) if the order is no longer open.
 */
export async function terminateTrailingStop(
  eventBus: EventEmitter,
  oid: number,
  status: 'reduceOnlyCanceled' | 'marginCanceled',
  at: number = Date.now(),
  // false = the caller batches the order update into a larger WS frame itself.
  emitUpdate: boolean = true,
  // true = the stop had FIRED when it was ended (fire-time margin failure): HL writes a `triggered`
  // history row first and sends [triggered, <status>] in one frame (round 6, T8b).
  afterTrigger: boolean = false,
): Promise<boolean> {
  const data = await redis.hgetall(KEYS.ORDER(oid));
  if (!data.oid || data.status !== 'open') return false;

  const pipeline = redis.pipeline();
  const frozen = buildTrailingBody(data, false);
  pipeline.hset(KEYS.ORDER(oid), 'trSnap', JSON.stringify(frozen));
  pipeline.hset(KEYS.ORDER(oid), 'status', status, 'updatedAt', String(at));
  pipeline.srem(KEYS.ORDERS_TRAILING, String(oid));
  pipeline.srem(KEYS.ORDERS_OPEN, String(oid));
  pipeline.srem(KEYS.ORDERS_TRIGGERS, String(oid));
  pipeline.zrem(KEYS.ORDERS_EXPIRY, String(oid));
  await pipeline.exec();

  if (afterTrigger) emitTrailingHistory(eventBus, data, 'triggered', at, frozen);
  emitTrailingHistory(eventBus, data, status, at, frozen);
  if (emitUpdate) {
    if (afterTrigger) {
      eventBus.emit('orderUpdateBatch', {
        userId: data.userId,
        updates: [
          { order: paperOrderFromHash(data, 'triggered', at), status: 'triggered' },
          { order: paperOrderFromHash(data, status, at), status },
        ],
      });
    } else {
      eventBus.emit('orderUpdate', {
        userId: data.userId,
        order: paperOrderFromHash(data, status, at),
        status,
      });
    }
  }
  return true;
}

/**
 * Reduce-only orphan handling. Call after ANY change to a user's position in `asset`
 * (`newSzi` = the position size AFTER the change). An OPEN reduce-only trailing stop that can
 * no longer reduce the position is auto-canceled with HL's status `reduceOnlyCanceled` at the
 * same timestamp as the position change.
 *
 * What HL was observed to do (probe rounds 4–5, captures 33_* / 34_*):
 *   - position goes FLAT                       → `reduceOnlyCanceled`  (long/sell and short/buy)
 *   - position FLIPS (long → short)            → `reduceOnlyCanceled`
 *   - position only PARTIALLY reduced          → stop stays open, size UNCHANGED
 *   - a reduce-only stop placed on a flat account is accepted and simply rests (no cancel then)
 * Not observed (assumption): a stop that was placed while flat and then sees the position open
 * in ITS OWN direction (e.g. a buy reduce-only stop, then a long opens) — treated as "cannot
 * reduce" and canceled here.
 *
 * Trailing stops only (decision D2): normal reduce-only limit/trigger orders keep today's behaviour.
 *
 * Returns the order updates (not emitted) so the caller can put them in the SAME websocket frame
 * as the position-changing order's own updates, as HL does. History rows ARE written here.
 */
export async function reconcileReduceOnlyStops(
  eventBus: EventEmitter,
  userId: string,
  asset: number,
  newSzi: string,
  at: number = Date.now(),
): Promise<Array<{ order: PaperOrder; status: OrderStatus }>> {
  const updates: Array<{ order: PaperOrder; status: OrderStatus }> = [];
  for (const oidStr of await redis.smembers(KEYS.ORDERS_TRAILING)) {
    const oid = parseInt(oidStr, 10);
    const data = await redis.hgetall(KEYS.ORDER(oid));
    if (
      !data.oid || data.status !== 'open' || data.userId !== userId ||
      data.asset !== String(asset) || data.reduceOnly !== 'true'
    ) continue;

    const isBuy = data.isBuy === 'true';
    const canReduce = gt(newSzi, '0') ? !isBuy : lt(newSzi, '0') ? isBuy : false;
    if (canReduce) continue;

    if (await terminateTrailingStop(eventBus, oid, 'reduceOnlyCanceled', at, false)) {
      updates.push({ order: paperOrderFromHash(data, 'reduceOnlyCanceled', at), status: 'reduceOnlyCanceled' });
    }
  }
  return updates;
}
