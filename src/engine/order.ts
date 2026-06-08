import { redis } from "../store/redis.js";
import { KEYS } from "../store/keys.js";
import { logger } from "../utils/logger.js";
import { lte, gte, isZero, gt, lt } from "../utils/math.js";
import { nextOid } from "../utils/id.js";
import { checkMarginForOrder } from "./margin.js";
import { OrderMatcher } from "../worker/order-matcher.js";
import { computeFillPrice } from "../utils/slippage.js";
import { eventBus } from "../worker/index.js";
import type {
  HlOrderWire,
  HlCancelRequest,
  HlCancelByCloidRequest,
  HlOrderResponseStatus,
  HlMeta,
} from "../types/hl.js";
import type { PaperOrder } from "../types/order.js";

const matcher = new OrderMatcher(eventBus);

// HL encodes sub-DEX asset ids as `100_000 + perpDexIdx*10_000 + universeIdx`.
// Anything < 100_000 is a main-DEX universe index. perpDexIdx aligns with
// the index in the array returned by /info perpDexs (where index 0 is null,
// index 1 is the first sub-DEX, etc.).
const SUB_DEX_OFFSET = 100_000;
const SUB_DEX_STRIDE = 10_000;

// HL spot assets are encoded as `10_000 + spotPairIndex`. The range
// [10_000, 100_000) is exclusively spot — main-DEX perp universe indices are
// in the low hundreds, and sub-DEX assets start at 100_000. Without this
// branch a spot asset id (e.g. 10_000 for the first pair) was misread as a
// main-DEX universe index and rejected as "Unknown asset".
const SPOT_OFFSET = 10_000;

interface SpotMetaCache {
  tokens: Array<{ name: string; szDecimals: number; index: number }>;
  universe: Array<{ name: string; tokens: [number, number]; index: number }>;
}

/** Decode a spot asset id → { pair name, base-token szDecimals }. */
async function loadSpotEntry(asset: number): Promise<{ name: string; szDecimals: number } | null> {
  const raw = await redis.get(KEYS.MARKET_SPOT_META);
  if (!raw) return null;
  const spot: SpotMetaCache = JSON.parse(raw);
  const idx = asset - SPOT_OFFSET;
  // universe is index-aligned, but match on `.index` defensively.
  const pair = spot.universe[idx]?.index === idx
    ? spot.universe[idx]
    : spot.universe.find((u) => u.index === idx);
  if (!pair) return null;
  const baseTokenIdx = pair.tokens[0];
  const baseTok = spot.tokens[baseTokenIdx]?.index === baseTokenIdx
    ? spot.tokens[baseTokenIdx]
    : spot.tokens.find((t) => t.index === baseTokenIdx);
  return { name: pair.name, szDecimals: baseTok?.szDecimals ?? 0 };
}

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

/** Sub-dex scope for an asset id. Returns the dex name ('xyz', 'flx', …) for
 *  asset >= 100_000, or '' for native-perp and spot. Used by the rest of the
 *  engine to key per-dex balance / positions / orders. */
export async function scopeForAsset(asset: number): Promise<string> {
  if (asset < SUB_DEX_OFFSET) return '';
  const offset = asset - SUB_DEX_OFFSET;
  const dexIdx = Math.floor(offset / SUB_DEX_STRIDE);
  const perpDexsRaw = await redis.get(KEYS.MARKET_PERPDEXS);
  if (!perpDexsRaw) return '';
  const perpDexs: Array<{ name: string } | null> = JSON.parse(perpDexsRaw);
  return perpDexs[dexIdx]?.name ?? '';
}

export async function resolveAssetCoin(asset: number): Promise<string | null> {
  if (asset >= SPOT_OFFSET && asset < SUB_DEX_OFFSET) {
    const spot = await loadSpotEntry(asset);
    return spot ? spot.name : null;
  }
  const found = await loadUniverseEntry(asset);
  return found ? found.universe[found.localIdx].name : null;
}

export async function getAssetDecimals(asset: number): Promise<number> {
  if (asset >= SPOT_OFFSET && asset < SUB_DEX_OFFSET) {
    const spot = await loadSpotEntry(asset);
    return spot ? spot.szDecimals : 0;
  }
  const found = await loadUniverseEntry(asset);
  return found ? found.universe[found.localIdx].szDecimals : 0;
}

export async function placeOrders(
  userId: string,
  orders: HlOrderWire[],
  grouping: string,
  // `builder` is an HL ACTION-level field (one per `order` action, applied to
  // every order in the batch) — not per-`HlOrderWire`. Threaded via opts so
  // every order in the batch sees the same builder; executeFill applies the
  // bundled exchange+builder fee on the taker side per HL behavior.
  opts?: { expiresAfter?: number; builder?: { b: string; f: number } },
): Promise<HlOrderResponseStatus[]> {
  const results: HlOrderResponseStatus[] = [];
  const placedOids: number[] = [];

  for (const wire of orders) {
    try {
      const result = await placeSingleOrder(userId, wire, grouping, opts);
      results.push(result);
      // Collect oids of orders that successfully made it onto the book or
      // fully filled — we'll wire OCO bracket links across them below.
      if (typeof result === "object" && result !== null) {
        if ("resting" in result && result.resting?.oid)
          placedOids.push(result.resting.oid);
        else if ("filled" in result && result.filled?.oid)
          placedOids.push(result.filled.oid);
      }
    } catch (err) {
      logger.error({ err, wire }, "Error placing order");
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
    const pipeline = redis.pipeline();
    if (grouping === 'positionTpsl') {
      // Entry-less bracket (TP/SL on an existing position): every leg is a
      // MUTUAL OCO sibling — a TP fill cancels the SL and vice versa, matching
      // real HL. BUG FIX: previously this used the parent/child wiring below,
      // which made the first leg (TP) the "parent"; a TP fill was then handled
      // by cancelOrderSiblings as a *parent* fill ("children stay alive"), so
      // the SL was left resting and never cancelled.
      for (const oid of placedOids) {
        const sibs = placedOids.filter((o) => o !== oid).map(String);
        if (sibs.length > 0) pipeline.sadd(KEYS.ORDER_BRACKET(oid), ...sibs);
      }
    } else {
      // normalTpsl: first order = entry (PARENT); the rest = OCO children.
      //   parent fills  → children survive to bracket the new position
      //   parent cancels→ cascade-cancel children
      //   child fills   → cancel sibling children (OCO)
      const [parentOid, ...childOids] = placedOids;
      if (childOids.length > 0) {
        pipeline.sadd(KEYS.ORDER_CHILDREN(parentOid), ...childOids.map(String));
        for (const childOid of childOids) {
          pipeline.set(KEYS.ORDER_PARENT(childOid), String(parentOid));
          const sibs = childOids.filter((o) => o !== childOid).map(String);
          if (sibs.length > 0) pipeline.sadd(KEYS.ORDER_BRACKET(childOid), ...sibs);
        }
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
  opts?: { expiresAfter?: number; builder?: { b: string; f: number } },
): Promise<HlOrderResponseStatus> {
  const coin = await resolveAssetCoin(wire.a);
  if (!coin) return { error: `Unknown asset ${wire.a}` };

  const isBuy = wire.b;
  const sz = wire.s;
  const limitPx = wire.p;
  const reduceOnly = wire.r;

  // Reject non-finite / non-positive sizes before they reach the fill +
  // position math. Internal callers (matchTwaps via placeOrders) bypass the
  // route-layer validateOrderWire, so without this a NaN size silently
  // corrupts the position (szi/entryPx/accountValue all become NaN).
  if (!Number.isFinite(parseFloat(sz)) || parseFloat(sz) <= 0) {
    return { error: `Invalid order size: ${sz}` };
  }

  const trigger = wire.t.trigger;

  // For trigger orders. Real HL wires include both `t.limit.tif` (as the
  // fallback for the trigger order's limit leg) AND `t.trigger`, but
  // some clients send trigger-only — guard the limit access so we don't
  // crash before reaching the branch.
  if (trigger) {
    return placeTriggeredOrder(
      userId,
      wire.a,
      coin,
      isBuy,
      sz,
      limitPx,
      reduceOnly,
      trigger,
      wire.c,
      grouping,
      opts?.builder,
    );
  }
  if (!wire.t.limit?.tif) {
    return { error: "Order missing both t.limit.tif and t.trigger" };
  }
  const tif = wire.t.limit.tif;

  // Get current mid price for immediate fill check
  const midPx = await redis.hget(KEYS.MARKET_MIDS, coin);

  // IOC: fill immediately if price crosses, otherwise cancel
  if (tif === "Ioc") {
    if (!midPx) return { error: "No market price available" };

    const wouldFill = isBuy ? lte(midPx, limitPx) : gte(midPx, limitPx);
    if (!wouldFill) {
      // IOC that can't fill immediately is cancelled
      return { error: "IOC order could not be filled" };
    }

    // Check margin
    if (!reduceOnly) {
      const hasMargin = await checkMarginForOrder(
        userId,
        wire.a,
        isBuy,
        sz,
        midPx,
      );
      if (!hasMargin) return { error: "Insufficient margin" };
    }

    // Create and immediately fill
    const oid = await nextOid();
    const now = Date.now();
    const order = buildOrder(
      oid,
      userId,
      wire.a,
      coin,
      isBuy,
      sz,
      limitPx,
      "limit",
      tif,
      reduceOnly,
      grouping,
      wire.c,
      now,
      opts?.builder,
    );

    await saveOrder(order, opts?.expiresAfter);
    // Mirror the GTC/restOrder pattern: emit an 'open' orderUpdate
    // BEFORE the fill so pg-sink inserts the order row. Without this,
    // the only orderUpdate pg-sink saw was the 'filled' one from
    // executeFill — and any race / startup-ordering miss there meant
    // the order never landed in Postgres, so it was absent from
    // /info historicalOrders (and therefore from slushy's Order History
    // + the autoOverlay's anchor-time lookup).
    eventBus.emit("orderUpdate", { userId, order, status: "open" });
    const fillPx = await computeFillPrice(order, midPx);
    await matcher.executeFill(order, fillPx);

    return { filled: { totalSz: sz, avgPx: fillPx, oid, cloid: wire.c } };
  }

  // ALO: reject if would immediately fill (post-only)
  if (tif === "Alo") {
    if (midPx) {
      const wouldFill = isBuy ? lte(midPx, limitPx) : gte(midPx, limitPx);
      if (wouldFill) {
        return { error: "ALO order would have crossed" };
      }
    }

    // Check margin for resting
    if (!reduceOnly) {
      const hasMargin = await checkMarginForOrder(
        userId,
        wire.a,
        isBuy,
        sz,
        limitPx,
      );
      if (!hasMargin) return { error: "Insufficient margin" };
    }

    const oid = await nextOid();
    const now = Date.now();
    const order = buildOrder(
      oid,
      userId,
      wire.a,
      coin,
      isBuy,
      sz,
      limitPx,
      "limit",
      tif,
      reduceOnly,
      grouping,
      wire.c,
      now,
      opts?.builder,
    );

    await saveOrder(order, opts?.expiresAfter);
    await restOrder(order);

    return { resting: { oid, cloid: wire.c } };
  }

  // GTC: fill if crosses, else rest
  if (midPx) {
    const wouldFill = isBuy ? lte(midPx, limitPx) : gte(midPx, limitPx);
    if (wouldFill) {
      // Check margin
      if (!reduceOnly) {
        const hasMargin = await checkMarginForOrder(
          userId,
          wire.a,
          isBuy,
          sz,
          midPx,
        );
        if (!hasMargin) return { error: "Insufficient margin" };
      }

      const oid = await nextOid();
      const now = Date.now();
      const order = buildOrder(
        oid,
        userId,
        wire.a,
        coin,
        isBuy,
        sz,
        limitPx,
        "limit",
        tif,
        reduceOnly,
        grouping,
        wire.c,
        now,
      );

      await saveOrder(order, opts?.expiresAfter);
      const fillPx = await computeFillPrice(order, midPx);
      await matcher.executeFill(order, fillPx);

      return { filled: { totalSz: sz, avgPx: fillPx, oid, cloid: wire.c } };
    }
  }

  // Rest the order
  if (!reduceOnly) {
    const hasMargin = await checkMarginForOrder(
      userId,
      wire.a,
      isBuy,
      sz,
      limitPx,
    );
    if (!hasMargin) return { error: "Insufficient margin" };
  }

  const oid = await nextOid();
  const now = Date.now();
  const order = buildOrder(
    oid,
    userId,
    wire.a,
    coin,
    isBuy,
    sz,
    limitPx,
    "limit",
    tif,
    reduceOnly,
    grouping,
    wire.c,
    now,
    opts?.builder,
  );

  await saveOrder(order, opts?.expiresAfter);
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
  trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" },
  cloid: string | undefined,
  grouping: string,
  builder?: { b: string; f: number },
): Promise<HlOrderResponseStatus> {
  const oid = await nextOid();
  const now = Date.now();

  const order = buildOrder(
    oid,
    userId,
    asset,
    coin,
    isBuy,
    sz,
    limitPx,
    "trigger",
    "Gtc",
    reduceOnly,
    grouping,
    cloid,
    now,
    builder,
  );
  order.triggerPx = trigger.triggerPx;
  order.tpsl = trigger.tpsl;
  order.isMarket = trigger.isMarket;

  await saveOrder(order);

  // Add to triggers set + scoped user-orders zset. Sub-dex orders land in
  // `user:${u}:orders:${dex}` so getOpenOrders/getFrontendOpenOrders with
  // dex===this dex pick them up; native orders stay in the legacy unscoped
  // `user:${u}:orders` zset (USER_ORDERS_SCOPED returns it for scope==='').
  const scope = await scopeForAsset(asset);
  await redis.sadd(KEYS.ORDERS_TRIGGERS, oid.toString());
  await redis.zadd(KEYS.USER_ORDERS_SCOPED(userId, scope), now, oid.toString());

  eventBus.emit("orderUpdate", { userId, order, status: "open" });

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
  orderType: "limit" | "trigger",
  tif: "Gtc" | "Ioc" | "Alo",
  reduceOnly: boolean,
  grouping: string,
  cloid: string | undefined,
  now: number,
  builder?: { b: string; f: number },
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
    grouping: grouping as PaperOrder["grouping"],
    status: "open",
    filledSz: "0",
    avgPx: "0",
    createdAt: now,
    updatedAt: now,
    ...(builder ? { builder } : {}),
  };
}

async function saveOrder(
  order: PaperOrder,
  expiresAfter?: number,
): Promise<void> {
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
  if (expiresAfter !== undefined) data.expiresAfter = expiresAfter.toString();
  // Persist the builder code as JSON so executeFill can charge the bundled
  // fee on every partial/full fill. Omit when unset so the hash stays small.
  if (order.builder) data.builder = JSON.stringify(order.builder);

  const pipeline = redis.pipeline();
  pipeline.hset(KEYS.ORDER(order.oid), data);
  if (order.cloid) {
    pipeline.hset(
      KEYS.USER_CLOIDS(order.userId),
      order.cloid,
      order.oid.toString(),
    );
  }
  // Register expiry in the sorted set so the matcher can sweep it
  if (expiresAfter !== undefined) {
    pipeline.zadd(KEYS.ORDERS_EXPIRY, expiresAfter, order.oid.toString());
  }
  await pipeline.exec();
}

async function restOrder(order: PaperOrder): Promise<void> {
  // Scope by asset so sub-dex limits land in the dex's USER_ORDERS_SCOPED
  // zset, not native's. Native scope ('') maps back to the legacy key.
  const scope = await scopeForAsset(order.asset);
  const pipeline = redis.pipeline();
  pipeline.sadd(KEYS.ORDERS_OPEN, order.oid.toString());
  pipeline.zadd(KEYS.USER_ORDERS_SCOPED(order.userId, scope), order.createdAt, order.oid.toString());
  await pipeline.exec();

  eventBus.emit("orderUpdate", { userId: order.userId, order, status: "open" });
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

    if (orderData.status !== "open") {
      results.push({
        error: `Order ${cancel.o} is not open (status: ${orderData.status})`,
      });
      continue;
    }

    const now = Date.now();
    const pipeline = redis.pipeline();
    pipeline.hset(
      KEYS.ORDER(cancel.o),
      "status",
      "cancelled",
      "updatedAt",
      now.toString(),
    );
    pipeline.srem(KEYS.ORDERS_OPEN, cancel.o.toString());
    pipeline.srem(KEYS.ORDERS_TRIGGERS, cancel.o.toString());
    pipeline.zrem(KEYS.ORDERS_EXPIRY, cancel.o.toString());
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
        if (
          childData.oid &&
          childData.status === "open" &&
          childData.userId === userId
        ) {
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

    eventBus.emit("orderUpdate", {
      userId,
      order: {
        oid: cancel.o,
        coin: orderData.coin,
        isBuy: orderData.isBuy === "true",
        sz: orderData.sz,
        limitPx: orderData.limitPx,
        status: "cancelled",
        asset: parseInt(orderData.asset, 10),
        userId,
        orderType: orderData.orderType,
        tif: orderData.tif,
        reduceOnly: orderData.reduceOnly === "true",
        grouping: orderData.grouping,
        filledSz: orderData.filledSz ?? "0",
        avgPx: orderData.avgPx ?? "0",
        createdAt: parseInt(orderData.createdAt, 10),
        updatedAt: now,
        cloid: orderData.cloid || undefined,
      } as PaperOrder,
      status: "cancelled",
    });

    results.push("success");
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
  await redis.hset(
    KEYS.USER_LEV(userId, asset),
    "leverage",
    leverage.toString(),
    "isCross",
    isCross.toString(),
  );
}

export async function updateIsolatedMargin(
  userId: string,
  asset: number,
  isBuy: boolean,
  ntli: number,
): Promise<{ ok: true } | { error: string }> {
  // ntli is signed: positive = add margin, negative = remove margin.
  // Convert from HL's 1e-6 integer units to a decimal string for Redis.
  const deltaUsd = (ntli / 1_000_000).toFixed(6);
  const posKey = KEYS.USER_POS(userId, asset);
  const posRaw = await redis.hgetall(posKey);
  if (!posRaw.asset) {
    return { error: `No isolated position for asset ${asset}` };
  }
  // Store the delta — the margin accounting worker will reconcile on next
  // funding tick. We only update the raw USD field here.
  const current = parseFloat(posRaw.rawUsd ?? "0");
  const updated = current + parseFloat(deltaUsd);
  await redis.hset(posKey, "rawUsd", updated.toFixed(6));
  return { ok: true };
}

export async function scheduleCancel(
  userId: string,
  time?: number,
): Promise<{ ok: true } | { error: string }> {
  // `time` is an optional unix-ms timestamp. When omitted, remove any
  // previously scheduled cancel (dead man's switch reset).
  const key = `user:${userId}:schedule_cancel`;
  if (time === undefined) {
    await redis.del(key);
    return { ok: true };
  }
  const nowMs = Date.now();
  if (time < nowMs + 5_000) {
    return {
      error: "scheduleCancel time must be at least 5 seconds in the future",
    };
  }
  // Store the target time. A background worker polls this and cancels all
  // open orders when the time is reached.
  await redis.set(key, String(time));
  return { ok: true };
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
  if (orderData.status !== "open") {
    return { error: `Cannot modify canceled or filled order` };
  }

  // Cancel the old order atomically
  const now = Date.now();
  const pipeline = redis.pipeline();
  pipeline.hset(
    KEYS.ORDER(oid),
    "status",
    "cancelled",
    "updatedAt",
    now.toString(),
  );
  pipeline.srem(KEYS.ORDERS_OPEN, oid.toString());
  pipeline.srem(KEYS.ORDERS_TRIGGERS, oid.toString());
  pipeline.zrem(KEYS.ORDERS_EXPIRY, oid.toString());
  await pipeline.exec();

  // Emit cancellation so WebSocket subscribers see the removal immediately
  eventBus.emit("orderUpdate", {
    userId,
    order: {
      oid,
      coin: orderData.coin,
      isBuy: orderData.isBuy === "true",
      sz: orderData.sz,
      limitPx: orderData.limitPx,
      status: "cancelled",
      asset: parseInt(orderData.asset, 10),
      userId,
      orderType: orderData.orderType,
      tif: orderData.tif,
      reduceOnly: orderData.reduceOnly === "true",
      grouping: orderData.grouping,
      filledSz: orderData.filledSz ?? "0",
      avgPx: orderData.avgPx ?? "0",
      createdAt: parseInt(orderData.createdAt, 10),
      updatedAt: now,
      cloid: orderData.cloid || undefined,
    } as PaperOrder,
    status: "cancelled",
  });

  // Place the replacement order (same grouping as original)
  const grouping = orderData.grouping ?? "na";
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
      if (orderData.status !== "open") {
        results.push({ error: `Cannot modify canceled or filled order` });
        continue;
      }

      // Cancel old atomically
      const now = Date.now();
      const pipeline = redis.pipeline();
      pipeline.hset(
        KEYS.ORDER(m.oid),
        "status",
        "cancelled",
        "updatedAt",
        now.toString(),
      );
      pipeline.srem(KEYS.ORDERS_OPEN, m.oid.toString());
      pipeline.srem(KEYS.ORDERS_TRIGGERS, m.oid.toString());
      pipeline.zrem(KEYS.ORDERS_EXPIRY, m.oid.toString());
      await pipeline.exec();

      // Emit cancellation event for WebSocket subscribers
      eventBus.emit("orderUpdate", {
        userId,
        order: {
          oid: m.oid,
          coin: orderData.coin,
          isBuy: orderData.isBuy === "true",
          sz: orderData.sz,
          limitPx: orderData.limitPx,
          status: "cancelled",
          asset: parseInt(orderData.asset, 10),
          userId,
          orderType: orderData.orderType,
          tif: orderData.tif,
          reduceOnly: orderData.reduceOnly === "true",
          grouping: orderData.grouping,
          filledSz: orderData.filledSz ?? "0",
          avgPx: orderData.avgPx ?? "0",
          createdAt: parseInt(orderData.createdAt, 10),
          updatedAt: now,
          cloid: orderData.cloid || undefined,
        } as PaperOrder,
        status: "cancelled",
      });

      // Place replacement and get its status
      const grouping = orderData.grouping ?? "na";
      const status = await placeSingleOrder(userId, m.order, grouping);
      results.push(status);
    } catch (err) {
      logger.error({ err, oid: m.oid }, "batchModify error");
      results.push({ error: String(err) });
    }
  }

  return results;
}

// ─── twapOrder ────────────────────────────────────────────────────────────────
// Persist the TWAP record and add it to the active set. Slice execution is
// driven ENTIRELY by the matcher loop (OrderMatcher.matchTwaps), which reads
// this record each tick, computes the next slice from elapsed time, submits
// it, and marks the TWAP finished at endTime. The field names written here
// MUST match what matchTwaps reads (startTime/endTime/totalSize/filledSize).
//
// Do NOT add a setInterval executor here. A previous version did, running a
// SECOND executor concurrently with matchTwaps — the two used incompatible
// field schemas, so matchTwaps read undefined→NaN and submitted NaN-size
// slices that corrupted the position/account value to NaN.
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

  const totalNum = parseFloat(totalSz);
  if (!Number.isFinite(totalNum) || totalNum <= 0) return { error: `Invalid TWAP size: ${totalSz}` };

  const twapId = await redis.incr(KEYS.SEQ_TWAP);
  const now = Date.now();

  // Schema consumed by OrderMatcher.matchTwaps — keep field names in sync.
  await redis.hset(KEYS.TWAP(twapId), {
    twapId:     twapId.toString(),
    userId,
    asset:      asset.toString(),
    coin,
    isBuy:      isBuy.toString(),
    reduceOnly: reduceOnly.toString(),
    totalSize:  totalSz,
    filledSize: '0',
    startTime:  now.toString(),
    endTime:    (now + minutes * 60_000).toString(),
    minutes:    minutes.toString(),
    status:     'running',
    createdAt:  now.toString(),
  });
  await redis.sadd(KEYS.TWAPS_ACTIVE, twapId.toString());
  await redis.zadd(KEYS.USER_TWAPS(userId), Date.now(), twapId.toString());

  return { twapId };
}

// ─── twapCancel ───────────────────────────────────────────────────────────────

export async function cancelTwapOrder(
  userId: string,
  twapId: number,
): Promise<{ ok: true } | { error: string }> {
  const twapData = await redis.hgetall(KEYS.TWAP(twapId));
  if (!twapData.twapId) return { error: `TWAP ${twapId} not found` };
  // Return same message for wrong-user as not-found to avoid enumeration
  if (twapData.userId !== userId) return { error: `TWAP ${twapId} not found` };
  if (twapData.status !== "running")
    return { error: `TWAP ${twapId} is not running` };

  // Setting status to 'cancelled' in Redis is picked up by the setInterval
  // callback on its next tick, which then calls clearInterval on itself.
  await redis.hset(KEYS.TWAP(twapId), "status", "cancelled");
  await redis.srem(KEYS.TWAPS_ACTIVE, twapId.toString());

  return { ok: true };
}
