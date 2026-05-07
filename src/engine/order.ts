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

// HL encodes sub-DEX asset ids as `100_000 + perpDexIdx*10_000 + universeIdx`.
// Anything < 100_000 is a main-DEX universe index. perpDexIdx aligns with
// the index in the array returned by /info perpDexs (where index 0 is null,
// index 1 is the first sub-DEX, etc.).
const SUB_DEX_OFFSET = 100_000;
const SUB_DEX_STRIDE = 10_000;

async function loadUniverseEntry(asset: number): Promise<{ universe: HlMeta['universe']; localIdx: number } | null> {
  if (asset < SUB_DEX_OFFSET) {
    const metaRaw = await redis.get(KEYS.MARKET_META);
    if (!metaRaw) return null;
    const meta: HlMeta = JSON.parse(metaRaw);
    if (asset < 0 || asset >= meta.universe.length) return null;
    return { universe: meta.universe, localIdx: asset };
  }
  // Sub-DEX
  const offset = asset - SUB_DEX_OFFSET;
  const dexIdx = Math.floor(offset / SUB_DEX_STRIDE);
  const localIdx = offset % SUB_DEX_STRIDE;
  const perpDexsRaw = await redis.get(KEYS.MARKET_PERPDEXS);
  if (!perpDexsRaw) return null;
  const perpDexs: Array<{ name: string } | null> = JSON.parse(perpDexsRaw);
  const dex = perpDexs[dexIdx];
  if (!dex || !dex.name) return null;
  const subMetaRaw = await redis.get(KEYS.MARKET_META_DEX(dex.name));
  if (!subMetaRaw) return null;
  const subMeta: HlMeta = JSON.parse(subMetaRaw);
  if (localIdx < 0 || localIdx >= subMeta.universe.length) return null;
  return { universe: subMeta.universe, localIdx };
}

export async function resolveAssetCoin(asset: number): Promise<string | null> {
  const found = await loadUniverseEntry(asset);
  return found ? found.universe[found.localIdx].name : null;
}

export async function getAssetDecimals(asset: number): Promise<number> {
  const found = await loadUniverseEntry(asset);
  return found ? found.universe[found.localIdx].szDecimals : 0;
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

async function placeSingleOrder(
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
