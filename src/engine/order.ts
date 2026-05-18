import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import { lte, gte, isZero, gt, lt } from '../utils/math.js';
import { nextOid } from '../utils/id.js';
import { checkMarginForOrder } from './margin.js';
import { OrderMatcher } from '../worker/order-matcher.js';
import { computeFillPrice } from '../utils/slippage.js';
import { eventBus } from '../worker/index.js';
import type { HlOrderWire, HlCancelRequest, HlCancelByCloidRequest, HlOrderResponseStatus, HlMeta } from '../types/hl.js';
import type { PaperOrder } from '../types/order.js';

const matcher = new OrderMatcher(eventBus);

export async function resolveAssetCoin(asset: number): Promise<string | null> {
  const metaRaw = await redis.get(KEYS.MARKET_META);
  if (!metaRaw) return null;
  const meta: HlMeta = JSON.parse(metaRaw);
  if (asset < 0 || asset >= meta.universe.length) return null;
  return meta.universe[asset].name;
}

export async function getAssetDecimals(asset: number): Promise<number> {
  const metaRaw = await redis.get(KEYS.MARKET_META);
  if (!metaRaw) return 0;
  const meta: HlMeta = JSON.parse(metaRaw);
  if (asset < 0 || asset >= meta.universe.length) return 0;
  return meta.universe[asset].szDecimals;
}

export async function placeOrders(
  userId: string,
  orders: HlOrderWire[],
  grouping: string,
): Promise<HlOrderResponseStatus[]> {
  const results: HlOrderResponseStatus[] = [];

  for (const wire of orders) {
    try {
      const result = await placeSingleOrder(userId, wire, grouping);
      results.push(result);
    } catch (err) {
      logger.error({ err, wire }, 'Error placing order');
      results.push({ error: String(err) });
    }
  }

  return results;
}

export async function placeSingleOrder(
  userId: string,
  wire: HlOrderWire,
  grouping: string,
): Promise<HlOrderResponseStatus> {
  const coin = await resolveAssetCoin(wire.a);
  if (!coin) return { error: `Unknown asset ${wire.a}` };

  const isBuy = wire.b;
  const sz = wire.s;
  const limitPx = wire.p;
  const reduceOnly = wire.r;
  const tif = wire.t.limit.tif;
  const trigger = wire.t.trigger;

  // For trigger orders
  if (trigger) {
    return placeTriggeredOrder(userId, wire.a, coin, isBuy, sz, limitPx, reduceOnly, trigger, wire.c, grouping);
  }

  // Get current mid price for immediate fill check
  const midPx = await redis.hget(KEYS.MARKET_MIDS, coin);

  // IOC: fill immediately if price crosses, otherwise cancel
  if (tif === 'Ioc') {
    if (!midPx) return { error: 'No market price available' };

    const wouldFill = isBuy ? lte(midPx, limitPx) : gte(midPx, limitPx);
    if (!wouldFill) {
      // IOC that can't fill immediately is cancelled
      return { error: 'IOC order could not be filled' };
    }

    // Check margin
    if (!reduceOnly) {
      const hasMargin = await checkMarginForOrder(userId, wire.a, isBuy, sz, midPx);
      if (!hasMargin) return { error: 'Insufficient margin' };
    }

    // Create and immediately fill
    const oid = await nextOid();
    const now = Date.now();
    const order = buildOrder(oid, userId, wire.a, coin, isBuy, sz, limitPx, 'limit', tif, reduceOnly, grouping, wire.c, now);

    await saveOrder(order);
    const fillPx = await computeFillPrice(order, midPx);
    await matcher.executeFill(order, fillPx);

    return { filled: { totalSz: sz, avgPx: fillPx, oid, cloid: wire.c } };
  }

  // ALO: reject if would immediately fill (post-only)
  if (tif === 'Alo') {
    if (midPx) {
      const wouldFill = isBuy ? lte(midPx, limitPx) : gte(midPx, limitPx);
      if (wouldFill) {
        return { error: 'ALO order would have crossed' };
      }
    }

    // Check margin for resting
    if (!reduceOnly) {
      const hasMargin = await checkMarginForOrder(userId, wire.a, isBuy, sz, limitPx);
      if (!hasMargin) return { error: 'Insufficient margin' };
    }

    const oid = await nextOid();
    const now = Date.now();
    const order = buildOrder(oid, userId, wire.a, coin, isBuy, sz, limitPx, 'limit', tif, reduceOnly, grouping, wire.c, now);

    await saveOrder(order);
    await restOrder(order);

    return { resting: { oid, cloid: wire.c } };
  }

  // GTC: fill if crosses, else rest
  if (midPx) {
    const wouldFill = isBuy ? lte(midPx, limitPx) : gte(midPx, limitPx);
    if (wouldFill) {
      // Check margin
      if (!reduceOnly) {
        const hasMargin = await checkMarginForOrder(userId, wire.a, isBuy, sz, midPx);
        if (!hasMargin) return { error: 'Insufficient margin' };
      }

      const oid = await nextOid();
      const now = Date.now();
      const order = buildOrder(oid, userId, wire.a, coin, isBuy, sz, limitPx, 'limit', tif, reduceOnly, grouping, wire.c, now);

      await saveOrder(order);
      const fillPx = await computeFillPrice(order, midPx);
      await matcher.executeFill(order, fillPx);

      return { filled: { totalSz: sz, avgPx: fillPx, oid, cloid: wire.c } };
    }
  }

  // Rest the order
  if (!reduceOnly) {
    const hasMargin = await checkMarginForOrder(userId, wire.a, isBuy, sz, limitPx);
    if (!hasMargin) return { error: 'Insufficient margin' };
  }

  const oid = await nextOid();
  const now = Date.now();
  const order = buildOrder(oid, userId, wire.a, coin, isBuy, sz, limitPx, 'limit', tif, reduceOnly, grouping, wire.c, now);

  await saveOrder(order);
  await restOrder(order);

  return { resting: { oid, cloid: wire.c } };
}

async function placeTriggeredOrder(
  userId: string,
  asset: number,
  coin: string,
  isBuy: boolean,
  sz: string,
  limitPx: string,
  reduceOnly: boolean,
  trigger: { isMarket: boolean; triggerPx: string; tpsl: 'tp' | 'sl' },
  cloid: string | undefined,
  grouping: string,
): Promise<HlOrderResponseStatus> {
  const oid = await nextOid();
  const now = Date.now();

  const order = buildOrder(oid, userId, asset, coin, isBuy, sz, limitPx, 'trigger', 'Gtc', reduceOnly, grouping, cloid, now);
  order.triggerPx = trigger.triggerPx;
  order.tpsl = trigger.tpsl;
  order.isMarket = trigger.isMarket;

  await saveOrder(order);

  // Add to triggers set
  await redis.sadd(KEYS.ORDERS_TRIGGERS, oid.toString());
  await redis.zadd(KEYS.USER_ORDERS(userId), now, oid.toString());

  eventBus.emit('orderUpdate', { userId, order, status: 'open' });

  return { resting: { oid, cloid } };
}

function buildOrder(
  oid: number,
  userId: string,
  asset: number,
  coin: string,
  isBuy: boolean,
  sz: string,
  limitPx: string,
  orderType: 'limit' | 'trigger',
  tif: 'Gtc' | 'Ioc' | 'Alo',
  reduceOnly: boolean,
  grouping: string,
  cloid: string | undefined,
  now: number,
): PaperOrder {
  return {
    oid,
    cloid,
    userId,
    asset,
    coin,
    isBuy,
    sz,
    limitPx,
    orderType,
    tif,
    reduceOnly,
    grouping: grouping as PaperOrder['grouping'],
    status: 'open',
    filledSz: '0',
    avgPx: '0',
    createdAt: now,
    updatedAt: now,
  };
}

async function saveOrder(order: PaperOrder): Promise<void> {
  const data: Record<string, string> = {
    oid: order.oid.toString(),
    userId: order.userId,
    asset: order.asset.toString(),
    coin: order.coin,
    isBuy: order.isBuy.toString(),
    sz: order.sz,
    limitPx: order.limitPx,
    orderType: order.orderType,
    tif: order.tif,
    reduceOnly: order.reduceOnly.toString(),
    grouping: order.grouping,
    status: order.status,
    filledSz: order.filledSz,
    avgPx: order.avgPx,
    createdAt: order.createdAt.toString(),
    updatedAt: order.updatedAt.toString(),
  };

  if (order.cloid) data.cloid = order.cloid;
  if (order.triggerPx) data.triggerPx = order.triggerPx;
  if (order.tpsl) data.tpsl = order.tpsl;
  if (order.isMarket !== undefined) data.isMarket = order.isMarket.toString();

  const pipeline = redis.pipeline();
  pipeline.hset(KEYS.ORDER(order.oid), data);
  if (order.cloid) {
    pipeline.hset(KEYS.USER_CLOIDS(order.userId), order.cloid, order.oid.toString());
  }
  await pipeline.exec();
}

async function restOrder(order: PaperOrder): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.sadd(KEYS.ORDERS_OPEN, order.oid.toString());
  pipeline.zadd(KEYS.USER_ORDERS(order.userId), order.createdAt, order.oid.toString());
  await pipeline.exec();

  eventBus.emit('orderUpdate', { userId: order.userId, order, status: 'open' });
}

export async function cancelOrders(
  userId: string,
  cancels: HlCancelRequest[],
): Promise<HlOrderResponseStatus[]> {
  const results: HlOrderResponseStatus[] = [];

  for (const cancel of cancels) {
    const orderData = await redis.hgetall(KEYS.ORDER(cancel.o));
    if (!orderData.oid || orderData.userId !== userId) {
      results.push({ error: `Order ${cancel.o} not found` });
      continue;
    }

    if (orderData.status !== 'open') {
      results.push({ error: `Order ${cancel.o} is not open (status: ${orderData.status})` });
      continue;
    }

    const now = Date.now();
    const pipeline = redis.pipeline();
    pipeline.hset(KEYS.ORDER(cancel.o), 'status', 'cancelled', 'updatedAt', now.toString());
    pipeline.srem(KEYS.ORDERS_OPEN, cancel.o.toString());
    pipeline.srem(KEYS.ORDERS_TRIGGERS, cancel.o.toString());
    await pipeline.exec();

    eventBus.emit('orderUpdate', {
      userId,
      order: {
        oid: cancel.o,
        coin: orderData.coin,
        isBuy: orderData.isBuy === 'true',
        sz: orderData.sz,
        limitPx: orderData.limitPx,
        status: 'cancelled',
        asset: parseInt(orderData.asset, 10),
        userId,
        orderType: orderData.orderType,
        tif: orderData.tif,
        reduceOnly: orderData.reduceOnly === 'true',
        grouping: orderData.grouping,
        filledSz: orderData.filledSz ?? '0',
        avgPx: orderData.avgPx ?? '0',
        createdAt: parseInt(orderData.createdAt, 10),
        updatedAt: now,
        cloid: orderData.cloid || undefined,
      } as PaperOrder,
      status: 'cancelled',
    });

    results.push('success');
  }

  return results;
}

export async function cancelByCloid(
  userId: string,
  cancels: HlCancelByCloidRequest[],
): Promise<HlOrderResponseStatus[]> {
  const results: HlOrderResponseStatus[] = [];

  for (const cancel of cancels) {
    const oidStr = await redis.hget(KEYS.USER_CLOIDS(userId), cancel.cloid);
    if (!oidStr) {
      results.push({ error: `cloid ${cancel.cloid} not found` });
      continue;
    }

    const oid = parseInt(oidStr, 10);
    const [result] = await cancelOrders(userId, [{ a: cancel.asset, o: oid }]);
    results.push(result);
  }

  return results;
}

export async function updateLeverage(
  userId: string,
  asset: number,
  isCross: boolean,
  leverage: number,
): Promise<void> {
  await redis.hset(KEYS.USER_LEV(userId, asset),
    'leverage', leverage.toString(),
    'isCross', isCross.toString(),
  );
}

// ─── modify ──────────────────────────────────────────────────────────────────
// HL modify = atomic cancel-and-replace.
// We cancel the old order and place a new one. The new OID is returned
// but HL's response shape for modify is just { type: 'default' } — the
// caller does not get the new OID back (confirmed from testnet capture).

export async function modifyOrder(
  userId: string,
  oid: number,
  newWire: HlOrderWire,
): Promise<{ ok: true } | { error: string }> {
  // Load the existing order
  const orderData = await redis.hgetall(KEYS.ORDER(oid));
  if (!orderData.oid || orderData.userId !== userId) {
    return { error: `Order ${oid} not found` };
  }
  if (orderData.status !== 'open') {
    return { error: `Cannot modify canceled or filled order` };
  }

  // Cancel the old order
  const now = Date.now();
  const pipeline = redis.pipeline();
  pipeline.hset(KEYS.ORDER(oid), 'status', 'cancelled', 'updatedAt', now.toString());
  pipeline.srem(KEYS.ORDERS_OPEN, oid.toString());
  pipeline.srem(KEYS.ORDERS_TRIGGERS, oid.toString());
  await pipeline.exec();
eventBus.emit('orderUpdate', { userId, order: { oid } as any, status: 'cancelled' });
  // Place the replacement order (same grouping as original)
  const grouping = orderData.grouping ?? 'na';
  await placeSingleOrder(userId, newWire, grouping);

  return { ok: true };
}

// ─── batchModify ─────────────────────────────────────────────────────────────
// Run modifyOrder for each entry. Returns one status per modify,
// same shape as placeOrders statuses (resting | filled | error).
// Confirmed from testnet: batchModify response type is 'order' with statuses.

export async function batchModifyOrders(
  userId: string,
  modifies: Array<{ oid: number; order: HlOrderWire }>,
): Promise<HlOrderResponseStatus[]> {
  const results: HlOrderResponseStatus[] = [];

  for (const m of modifies) {
    try {
      const orderData = await redis.hgetall(KEYS.ORDER(m.oid));
      if (!orderData.oid || orderData.userId !== userId) {
        results.push({ error: `Order ${m.oid} not found` });
        continue;
      }
      if (orderData.status !== 'open') {
        results.push({ error: `Cannot modify canceled or filled order` });
        continue;
      }

      // Cancel old
      const now = Date.now();
      const pipeline = redis.pipeline();
      pipeline.hset(KEYS.ORDER(m.oid), 'status', 'cancelled', 'updatedAt', now.toString());
      pipeline.srem(KEYS.ORDERS_OPEN, m.oid.toString());
      pipeline.srem(KEYS.ORDERS_TRIGGERS, m.oid.toString());
      await pipeline.exec();

      // Place replacement and get its status
      const grouping = orderData.grouping ?? 'na';
      const status = await placeSingleOrder(userId, m.order, grouping);
      results.push(status);
    } catch (err) {
      logger.error({ err, oid: m.oid }, 'batchModify error');
      results.push({ error: String(err) });
    }
  }

  return results;
}

// ─── twapOrder ────────────────────────────────────────────────────────────────
// Basic TWAP: generate a twapId, store metadata in Redis, schedule
// sub-orders every 30 seconds over m minutes using setInterval.
// Each sub-order = totalSize / numSlices placed as an IOC market order.
// This is a v1 approximation — no 3× scaling for under-fills.

export async function createTwapOrder(
  userId: string,
  asset: number,
  isBuy: boolean,
  totalSz: string,
  reduceOnly: boolean,
  minutes: number,
): Promise<{ twapId: number } | { error: string }> {
  const coin = await resolveAssetCoin(asset);
  if (!coin) return { error: `Unknown asset ${asset}` };

  // Generate twapId
  const twapId = await redis.incr(KEYS.SEQ_TWAP);

  // Compute slices: HL uses ~30s intervals
  const intervalMs  = 30_000;
  const numSlices   = Math.max(1, Math.round((minutes * 60_000) / intervalMs));
  const sliceSzNum  = parseFloat(totalSz) / numSlices;
  const szDecimals  = await getAssetDecimals(asset);
  const sliceSz     = sliceSzNum.toFixed(szDecimals);

  // Store TWAP metadata in Redis
  await redis.hset(KEYS.TWAP(twapId), {
    twapId:    twapId.toString(),
    userId,
    asset:     asset.toString(),
    coin,
    isBuy:     isBuy.toString(),
    totalSz,
    sliceSz,
    reduceOnly: reduceOnly.toString(),
    minutes:   minutes.toString(),
    numSlices: numSlices.toString(),
    filled:    '0',
    status:    'running',
    createdAt: Date.now().toString(),
  });
  await redis.sadd(KEYS.TWAPS_ACTIVE, twapId.toString());

  // Schedule sub-orders
  let slicesFired = 0;
  const interval = setInterval(async () => {
    try {
      // Check if cancelled
      const twapStatus = await redis.hget(KEYS.TWAP(twapId), 'status');
      if (twapStatus !== 'running') {
        clearInterval(interval);
        return;
      }

      slicesFired++;

      // Get current mid price for this slice
      const midPx = await redis.hget(KEYS.MARKET_MIDS, coin);
      if (!midPx) {
        logger.warn({ twapId, coin }, 'TWAP slice skipped — no mid price');
        return;
      }

      // Place slice as GTC limit at mid price (best approximation of market)
      const wire: HlOrderWire = {
        a: asset,
        b: isBuy,
        p: midPx,
        s: sliceSz,
        r: reduceOnly,
        t: { limit: { tif: 'Ioc' } },
      };

      const status = await placeSingleOrder(userId, wire, 'na');
      logger.info({ twapId, slicesFired, numSlices, status }, 'TWAP slice executed');

      // Update filled count
      await redis.hincrby(KEYS.TWAP(twapId), 'filled', 1);

      // Stop when all slices fired
      if (slicesFired >= numSlices) {
        clearInterval(interval);
        await redis.hset(KEYS.TWAP(twapId), 'status', 'completed');
        await redis.srem(KEYS.TWAPS_ACTIVE, twapId.toString());
        logger.info({ twapId }, 'TWAP completed');
      }
    } catch (err) {
      logger.error({ err, twapId }, 'TWAP slice error');
    }
  }, intervalMs);

  return { twapId };
}

// ─── twapCancel ───────────────────────────────────────────────────────────────

export async function cancelTwapOrder(
  userId: string,
  twapId: number,
): Promise<{ ok: true } | { error: string }> {
  const twapData = await redis.hgetall(KEYS.TWAP(twapId));
  if (!twapData.twapId) return { error: `TWAP ${twapId} not found` };
  if (twapData.userId !== userId) return { error: `TWAP ${twapId} not found` };
  if (twapData.status !== 'running') return { error: `TWAP ${twapId} is not running` };

  await redis.hset(KEYS.TWAP(twapId), 'status', 'cancelled');
  await redis.srem(KEYS.TWAPS_ACTIVE, twapId.toString());

  return { ok: true };
}