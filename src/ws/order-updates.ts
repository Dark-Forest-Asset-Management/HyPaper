/**
 * Shape one `orderUpdates` WebSocket entry.
 *
 * Normal orders keep HyPaper's existing shape EXACTLY (this file only moved
 * it). Trailing stops use HL's observed shape (probe rounds 1–5, captures
 * 31_trigger_ws_events / 33_orphan_ws_events / 34_reduceonly_ws_events):
 *   { order:{ coin, side, limitPx, sz, oid, timestamp, origSz[, reduceOnly:true] },
 *     status, statusTimestamp }
 *  - a PLAIN order body — no triggerCondition / triggerPx / orderType, even
 *    though frontendOpenOrders carries them;
 *  - limitPx printed with ≥1 decimal ("74480.0");
 *  - `reduceOnly` present only when true;
 *  - status strings `open | triggered | filled | canceled | reduceOnlyCanceled`
 *    (US spelling for canceled);
 *  - the `filled` entry has timestamp = fill time and sz = the UNFILLED REMAINDER ("0.0" for a full fill or a
 *    reduce-only clamp; 0.00436 after a margin-partial fire of 0.00516), while every other entry carries the
 *    placement time and the full sz.
 */

import { fmtPrice1 } from '../engine/trailing-math.js';
import { D } from '../utils/math.js';
import type { PaperOrder } from '../types/order.js';

/** sz − filledSz, printed like HL ("0.0" when nothing is left). */
function remainder(order: PaperOrder): string {
  const rem = D(order.sz).minus(order.filledSz ?? '0');
  return rem.lte(0) ? '0.0' : rem.toFixed();
}

export function shapeOrderUpdate(order: PaperOrder, status: string) {
  if (order.orderType === 'trailingStop') {
    const filled = status === 'filled';
    const body: {
      coin: string; side: 'A' | 'B'; limitPx: string; sz: string; oid: number;
      timestamp: number; origSz: string; reduceOnly?: boolean;
    } = {
      coin: order.coin,
      side: order.isBuy ? 'B' : 'A',
      limitPx: fmtPrice1(order.limitPx),
      sz: filled ? remainder(order) : order.sz,
      oid: order.oid,
      timestamp: filled ? order.updatedAt : order.createdAt,
      origSz: order.sz,
    };
    if (order.reduceOnly) body.reduceOnly = true;
    return {
      order: body,
      status: status === 'cancelled' ? 'canceled' : status,
      statusTimestamp: order.updatedAt,
    };
  }

  return {
    order: {
      coin: order.coin,
      side: order.isBuy ? 'B' : 'A',
      limitPx: order.limitPx,
      sz: order.sz,
      oid: order.oid,
      timestamp: order.createdAt,
      origSz: order.sz,
      cloid: order.cloid,
    },
    status,
    statusTimestamp: order.updatedAt,
  };
}
