import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import { lte, gte, isZero, gt, lt } from '../utils/math.js';
import { nextOid, nextTwapId } from '../utils/id.js';
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
  opts?: { expiresAfter?: number },
): Promise<HlOrderResponseStatus[]> {
  const results: HlOrderResponseStatus[] = [];
  const placedOids: number[] = [];

  for (const wire of orders) {
    try {
      const result = await placeSingleOrder(userId, wire, grouping, opts);
      results.push(result);
      // Collect oids of orders that successfully made it onto the book or
      // fully filled — we'll wire OCO bracket links across them below.
      if (typeof result === 'object' && result !== null) {
        if ('resting' in result && result.resting?.oid) placedOids.push(result.resting.oid);
        else if ('filled' in result && result.filled?.oid) placedOids.push(result.filled.oid);
      }
    } catch (err) {
      logger.error({ err, wire }, 'Error placing order');
      results.push({ error: String(err) });
    }
  }

  // Bracket linkage for `normalTpsl` / `positionTpsl`. HL convention:
  // first order in the batch is the PARENT (entry), the rest are CHILDREN
  // (TP / SL exits). The link structure is asymmetric so each fill type
  // cascades correctly:
  //
  //   parent.children = [child1, child2, ...]   ← used on parent cancel
  //   child.parent    = parent                  ← reverse pointer
  //   child.bracket   = [other children]        ← used on child fill (OCO)
  //
  // Behavior:
  //   parent fills    → children stay alive (they bracket the new position)
  //   parent cancels  → cascade-cancel children (no entry = no bracket)
  //   child fills     → cancel sibling children (OCO; only one exit fires)
  //   child cancels   → no cascade (user-explicit one-leg cancel)
  if ((grouping === 'normalTpsl' || grouping === 'positionTpsl') && placedOids.length > 1) {
    const [parentOid, ...childOids] = placedOids;
    const pipeline = redis.pipeline();
    if (childOids.length > 0) {
      pipeline.sadd(KEYS.ORDER_CHILDREN(parentOid), ...childOids.map(String));
      for (const childOid of childOids) {
        pipeline.set(KEYS.ORDER_PARENT(childOid), String(parentOid));
        const sibs = childOids.filter((o) => o !== childOid).map(String);
        if (sibs.length > 0) pipeline.sadd(KEYS.ORDER_BRACKET(childOid), ...sibs);
      }
    }
    await pipeline.exec();
  }

  return results;
}

export async function placeSingleOrder(
  userId: string,
  wire: HlOrderWire,
  grouping: string,
  opts?: { expiresAfter?: number },
): Promise<HlOrderResponseStatus> {
  const coin = await resolveAssetCoin(wire.a);
  if (!coin) return { error: `Unknown asset ${wire.a}` };

  const isBuy = wire.b;
  const sz = wire.s;
  const limitPx = wire.p;
  const reduceOnly = wire.r;
  const trigger = wire.t.trigger;

  // For trigger orders. Real HL wires include both `t.limit.tif` (as the
  // fallback for the trigger order's limit leg) AND `t.trigger`, but
  // some clients send trigger-only — guard the limit access so we don't
  // crash before reaching the branch.
  if (trigger) {
    return placeTriggeredOrder(userId, wire.a, coin, isBuy, sz, limitPx, reduceOnly, trigger, wire.c, grouping);
  }
  if (!wire.t.limit?.tif) {
    return { error: 'Order missing both t.limit.tif and t.trigger' };
  }
  const tif = wire.t.limit.tif;

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

    // Bracket cascade on cancel:
    //   - If THIS oid is a PARENT (has children registered), cascade-cancel
    //     all open children. A bracket without an entry is meaningless.
    //   - If THIS oid is a CHILD, do NOT cascade. The user explicitly
    //     cancelled one bracket leg; the surviving leg + parent remain.
    //   - Always clean up any reverse-pointers we own so the next
    //     event finds a clean state.
    const childrenOids = await redis.smembers(KEYS.ORDER_CHILDREN(cancel.o));
    if (childrenOids.length > 0) {
      await redis.del(KEYS.ORDER_CHILDREN(cancel.o));
      const childCancels: HlCancelRequest[] = [];
      for (const childStr of childrenOids) {
        const childOid = parseInt(childStr, 10);
        if (!Number.isFinite(childOid)) continue;
        const childData = await redis.hgetall(KEYS.ORDER(childOid));
        if (childData.oid && childData.status === 'open' && childData.userId === userId) {
          childCancels.push({ a: parseInt(childData.asset, 10), o: childOid });
        }
        // Drop the child's reverse pointers regardless of status.
        await redis.del(KEYS.ORDER_PARENT(childOid));
        await redis.del(KEYS.ORDER_BRACKET(childOid));
      }
      if (childCancels.length > 0) await cancelOrders(userId, childCancels);
    } else {
      // Child or unlinked: clean any sibling/parent links we own.
      await redis.del(KEYS.ORDER_BRACKET(cancel.o));
      await redis.del(KEYS.ORDER_PARENT(cancel.o));
    }

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
