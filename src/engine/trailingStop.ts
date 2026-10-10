/**
 * Trailing-stop placement (the /exchange `trailingStop` action).
 *
 * Evaluation (activation, best/trigger ratchet, firing) lives in the matcher
 * (OrderMatcher.matchTrailingStops) and the pure rules in ./trailing-math.ts;
 * Redis-level helpers in ./trailing-state.ts. This module only validates and
 * PLACES a stop.
 *
 * Deliberate differences from placing a normal order, all driven by what HL
 * was observed to do (scripts/captures/trailing-stop-summary.md, rounds 1–5):
 *  - NO margin check at placement — HL trigger orders don't reserve margin
 *    while resting; margin is checked when the stop FIRES.
 *  - NO reduce-only position check — HL accepts a reduce-only stop on a flat
 *    account (both sides) and with a size larger than the position.
 *  - NO wrong-side activation rejection.
 *  - NO order expiry for `expiresAfter` (HL treats it as request expiry — see below).
 */

import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { nextOid } from '../utils/id.js';
import { resolveAssetCoin, scopeForAsset, getAssetDecimals } from './order.js';
import { getFreshMark, refreshMarks } from '../worker/mark-feed.js';
import {
  validateTrailingStop, validatePxAgainstReference, paramsFromWire, evaluateTrailing, fieldsFrom, buildTrailingBody,
  type TrailingStopWire,
} from './trailing-math.js';
import { paperOrderFromHash, emitTrailingHistory } from './trailing-state.js';

const SPOT_OFFSET = 10_000;
const SUB_DEX_OFFSET = 100_000;

export async function placeTrailingStop(
  userId: string,
  action: TrailingStopWire,
): Promise<{ oid: number } | { error: string }> {
  // Perps only (main + HIP-3 sub-dex). Spot pair ids sit in [10_000, 100_000).
  if (action.asset >= SPOT_OFFSET && action.asset < SUB_DEX_OFFSET) {
    return { error: `Unknown asset ${action.asset}` };
  }
  const coin = await resolveAssetCoin(action.asset);
  if (!coin) return { error: `Unknown asset ${action.asset}` };
  const szDecimals = await getAssetDecimals(action.asset);

  // Validation needs the coin's price decimals (px is normalised to them).
  const semanticError = validateTrailingStop(action, szDecimals);
  if (semanticError) return { error: semanticError };

  // Ask the worker for a per-coin activeAssetCtx (mark) subscription. Lazy import: the
  // worker module pulls in the whole engine and must not be a static dependency of this one.
  const { eventBus } = await import('../worker/index.js');
  eventBus.emit('markSub', { coin });

  // Seed with a fresh MARK. If the WS feed has no recent frame yet (new coin / first
  // stop after boot) fall back to one HTTP fetch rather than failing the placement.
  let mark = await getFreshMark(coin);
  if (!mark) {
    await refreshMarks([coin]);
    mark = await getFreshMark(coin);
  }
  if (!mark) return { error: 'No market price available' };

  const params = paramsFromWire(action, szDecimals);
  const boundError = validatePxAgainstReference(params, mark);
  if (boundError) return { error: boundError };
  const ev = evaluateTrailing(params, { activated: false, best: null }, mark);

  const oid = await nextOid();
  const now = Date.now();
  const data: Record<string, string> = {
    oid: String(oid),
    userId,
    asset: String(action.asset),
    coin,
    isBuy: String(action.isBuy),
    sz: action.sz,
    limitPx: ev.limitPx,
    orderType: 'trailingStop',
    // The DB column is notNull; the wire output gates tif to null while the stop is open.
    tif: 'Gtc',
    reduceOnly: String(action.reduceOnly),
    grouping: 'na',
    status: 'open',
    filledSz: '0',
    avgPx: '0',
    createdAt: String(now),
    updatedAt: String(now),
    triggerPx: ev.triggerPx ?? '',
    ...fieldsFrom(params, ev.state),
  };
  // Frozen snapshot = the body as of placement (what HL's orderStatus keeps serving, D1).
  data.trSnap = JSON.stringify(buildTrailingBody(data, false));

  // NOTE: no expiry is registered. On HL `expiresAfter` expires the REQUEST, not the order: a stop placed with
  // expiresAfter = now + 90 s was still open long after the deadline (round 6, T9). The request-level check
  // ("Action already expired") lives in the /exchange route.
  const scope = await scopeForAsset(action.asset);
  const pipeline = redis.pipeline();
  pipeline.hset(KEYS.ORDER(oid), data);
  // Same per-user zset every other open order lives in, so openOrders / frontendOpenOrders
  // see it — but NOT ORDERS_OPEN / ORDERS_TRIGGERS: the limit and TP/SL matchers never touch it.
  pipeline.zadd(KEYS.USER_ORDERS_SCOPED(userId, scope), now, String(oid));
  pipeline.sadd(KEYS.ORDERS_TRAILING, String(oid));
  await pipeline.exec();

  emitTrailingHistory(eventBus, data, 'open', now, buildTrailingBody(data, false));
  eventBus.emit('orderUpdate', {
    userId,
    order: paperOrderFromHash(data, 'open', now),
    status: 'open',
  });

  return { oid };
}
