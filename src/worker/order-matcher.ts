import { EventEmitter } from 'node:events';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { D, sub, mul, add, isZero, gt, lt, gte, lte, abs, neg, min } from '../utils/math.js';
import { nextTid } from '../utils/id.js';
import { computeFillPrice } from '../utils/slippage.js';
import type { PaperOrder, PaperFill } from '../types/order.js';

export class OrderMatcher {
  private isRunning = false;
  private eventBus: EventEmitter;

  constructor(eventBus: EventEmitter) {
    this.eventBus = eventBus;
  }

  async matchAll(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.matchOpenOrders();
      await this.matchTriggerOrders();
      await this.matchTwaps();
      await this.sweepExpired();
    } catch (err) {
      logger.error({ err }, 'Order matcher error');
    } finally {
      this.isRunning = false;
    }
  }

  /** Process active TWAPs by submitting an IOC market suborder for the
   *  amount of progress that's elapsed since the last slice. HL spec is
   *  ~30s suborders (max 3% slippage, up-to-3× catchup). v1 implements:
   *    - 30s minimum gap between slices
   *    - linear filling: target_filled = totalSize * (elapsed / duration)
   *    - submit IOC market for (target_filled - current_filled)
   *    - 3% slippage cap, 3× catchup are NOT modelled — flagged
   *      approximation; revisit once HL testnet captures show real
   *      suborder shapes. */
  private async matchTwaps(): Promise<void> {
    const ids = await redis.smembers(KEYS.TWAPS_ACTIVE);
    if (ids.length === 0) return;
    const now = Date.now();
    for (const idStr of ids) {
      const id = parseInt(idStr, 10);
      const data = await redis.hgetall(KEYS.TWAP(id));
      if (!data.twapId) {
        await redis.srem(KEYS.TWAPS_ACTIVE, idStr);
        continue;
      }
      if (data.status !== 'running') {
        await redis.srem(KEYS.TWAPS_ACTIVE, idStr);
        continue;
      }
      const startTime = parseInt(data.startTime, 10);
      const endTime = parseInt(data.endTime, 10);
      const totalSize = parseFloat(data.totalSize);
      const filledSize = parseFloat(data.filledSize || '0');
      const lastSubmittedAt = parseInt(data.lastSubmittedAt || '0', 10);

      // Guard a malformed/legacy record: missing numeric fields parse to NaN.
      // Without this the NaN flows into the slice size and corrupts the
      // position. Finish + drop it rather than spin on it every tick.
      if (!Number.isFinite(totalSize) || !Number.isFinite(startTime) || !Number.isFinite(endTime)) {
        logger.warn({ twapId: id }, 'TWAP record has non-finite fields — finishing');
        await redis.hset(KEYS.TWAP(id), 'status', 'finished');
        await redis.srem(KEYS.TWAPS_ACTIVE, idStr);
        continue;
      }

      // Mark finished if past the end and (mostly) filled.
      if (now >= endTime || filledSize >= totalSize) {
        await redis.hset(KEYS.TWAP(id), 'status', 'finished', 'lastSubmittedAt', String(now));
        await redis.srem(KEYS.TWAPS_ACTIVE, idStr);
        this.eventBus.emit('twapUpdate', { userId: data.userId, twapId: id, status: 'finished' });
        continue;
      }

      // 30s minimum gap between slices.
      if (lastSubmittedAt && now - lastSubmittedAt < 30_000) continue;

      const elapsedMs = now - startTime;
      const totalMs = endTime - startTime;
      const targetFilled = totalSize * (elapsedMs / totalMs);
      const sliceSize = Math.max(0, targetFilled - filledSize);
      if (!Number.isFinite(sliceSize) || sliceSize <= 0) continue;

      const midPx = await redis.hget(KEYS.MARKET_MIDS, data.coin);
      if (!midPx) continue;

      // Submit IOC market via the engine. We import lazily to avoid a
      // circular import (engine -> matcher -> engine).
      const { placeOrders } = await import('../engine/order.js');
      const slipPx = data.isBuy === 'true' ? parseFloat(midPx) * 1.05 : parseFloat(midPx) * 0.95;
      const wire = {
        a: parseInt(data.asset, 10),
        b: data.isBuy === 'true',
        p: slipPx.toFixed(8),
        s: sliceSize.toFixed(8),
        r: data.reduceOnly === 'true',
        t: { limit: { tif: 'Ioc' as const } },
      };
      try {
        const [result] = await placeOrders(data.userId, [wire], 'na');
        // Update progress only if something actually filled.
        if (typeof result === 'object' && result !== null && 'filled' in result && result.filled?.totalSz) {
          const newFilled = filledSize + parseFloat(result.filled.totalSz);
          await redis.hset(KEYS.TWAP(id), 'filledSize', String(newFilled), 'lastSubmittedAt', String(now));
          this.eventBus.emit('twapUpdate', { userId: data.userId, twapId: id, status: 'running', filledSize: newFilled });
        } else {
          // Bump lastSubmittedAt so we don't hammer the matcher with the
          // same failing slice every tick.
          await redis.hset(KEYS.TWAP(id), 'lastSubmittedAt', String(now));
        }
      } catch (err) {
        logger.warn({ err, twapId: id }, 'TWAP slice submit failed');
        await redis.hset(KEYS.TWAP(id), 'lastSubmittedAt', String(now));
      }
    }
  }

  /** Cancel any open orders past their `expiresAfter` deadline. The
   *  expiry sorted set is keyed by oid with score = expiry-ms; we pop
   *  from the front while score <= now. */
  private async sweepExpired(): Promise<void> {
    const now = Date.now();
    const expired = await redis.zrangebyscore(KEYS.ORDERS_EXPIRY, '-inf', String(now));
    if (expired.length === 0) return;
    for (const oidStr of expired) {
      const oid = parseInt(oidStr, 10);
      if (!Number.isFinite(oid)) continue;
      const data = await redis.hgetall(KEYS.ORDER(oid));
      await redis.zrem(KEYS.ORDERS_EXPIRY, oidStr);
      if (!data.oid || data.status !== 'open') continue;
      const pipeline = redis.pipeline();
      pipeline.hset(KEYS.ORDER(oid), 'status', 'cancelled', 'updatedAt', String(now));
      pipeline.srem(KEYS.ORDERS_OPEN, oidStr);
      pipeline.srem(KEYS.ORDERS_TRIGGERS, oidStr);
      await pipeline.exec();
      this.eventBus.emit('orderUpdate', {
        userId: data.userId,
        order: {
          oid,
          coin: data.coin,
          isBuy: data.isBuy === 'true',
          sz: data.sz,
          limitPx: data.limitPx,
          status: 'cancelled' as const,
          asset: parseInt(data.asset, 10),
          userId: data.userId,
          orderType: (data.orderType ?? 'limit') as 'limit' | 'trigger',
          tif: (data.tif ?? 'Gtc') as 'Gtc' | 'Ioc' | 'Alo',
          reduceOnly: data.reduceOnly === 'true',
          grouping: (data.grouping ?? 'na') as 'na' | 'normalTpsl' | 'positionTpsl',
          filledSz: data.filledSz ?? '0',
          avgPx: data.avgPx ?? '0',
          createdAt: parseInt(data.createdAt, 10),
          updatedAt: now,
          cloid: data.cloid || undefined,
        } as PaperOrder,
        status: 'cancelled',
      });
    }
  }

  private async matchOpenOrders(): Promise<void> {
    const oids = await redis.smembers(KEYS.ORDERS_OPEN);
    if (oids.length === 0) return;

    const mids = await redis.hgetall(KEYS.MARKET_MIDS);
    if (Object.keys(mids).length === 0) return;

    for (const oidStr of oids) {
      const oid = parseInt(oidStr, 10);
      const orderData = await redis.hgetall(KEYS.ORDER(oid));
      if (!orderData || !orderData.coin) continue;

      const order = this.parseOrder(orderData);
      if (order.status !== 'open') {
        await redis.srem(KEYS.ORDERS_OPEN, oidStr);
        continue;
      }

      const midPx = mids[order.coin];
      if (!midPx) continue;

      // Limit buy fills when midPx <= limitPx
      // Limit sell fills when midPx >= limitPx
      const shouldFill = order.isBuy
        ? lte(midPx, order.limitPx)
        : gte(midPx, order.limitPx);

      if (shouldFill) {
        const fillPx = await computeFillPrice(order, midPx);
        await this.executeFill(order, fillPx, false); // rested orders are maker
      }
    }
  }

  private async matchTriggerOrders(): Promise<void> {
    const oids = await redis.smembers(KEYS.ORDERS_TRIGGERS);
    if (oids.length === 0) return;

    const mids = await redis.hgetall(KEYS.MARKET_MIDS);
    if (Object.keys(mids).length === 0) return;

    for (const oidStr of oids) {
      const oid = parseInt(oidStr, 10);
      const orderData = await redis.hgetall(KEYS.ORDER(oid));
      if (!orderData || !orderData.coin) continue;

      const order = this.parseOrder(orderData);
      if (order.status !== 'open') {
        await redis.srem(KEYS.ORDERS_TRIGGERS, oidStr);
        continue;
      }

      const midPx = mids[order.coin];
      if (!midPx || !order.triggerPx || !order.tpsl) continue;

      const triggered = this.checkTrigger(order, midPx);
      if (triggered) {
        // Fill at mid price for market trigger orders, or at limit price for limit
        const basePx = order.isMarket ? midPx : order.limitPx;
        const limitClamp = order.isMarket ? null : order.limitPx;
        const fillPx = await computeFillPrice(order, basePx, limitClamp);
        await this.executeFill(order, fillPx, true); // trigger fills are taker
        await redis.srem(KEYS.ORDERS_TRIGGERS, oidStr);
      }
    }
  }

  private checkTrigger(order: PaperOrder, midPx: string): boolean {
    const triggerPx = order.triggerPx!;
    const tpsl = order.tpsl!;

    if (tpsl === 'sl') {
      // sl + sell (close long) → midPx <= triggerPx
      // sl + buy (close short) → midPx >= triggerPx
      return order.isBuy ? gte(midPx, triggerPx) : lte(midPx, triggerPx);
    } else {
      // tp + sell (close long) → midPx >= triggerPx
      // tp + buy (close short) → midPx <= triggerPx
      return order.isBuy ? lte(midPx, triggerPx) : gte(midPx, triggerPx);
    }
  }

  async executeFill(order: PaperOrder, fillPx: string, isTaker: boolean = true): Promise<void> {
    const userId = order.userId;
    const asset = order.asset;
    const fillSz = sub(order.sz, order.filledSz);

    if (isZero(fillSz)) return;

    // Read current position
    const posData = await redis.hgetall(KEYS.USER_POS(userId, asset));
    const currentSzi = posData.szi ?? '0';
    const currentEntryPx = posData.entryPx ?? '0';

    // Calculate signed fill size
    const signedFillSz = order.isBuy ? fillSz : neg(fillSz);

    // Handle reduceOnly
    if (order.reduceOnly) {
      if (isZero(currentSzi)) return; // no position to reduce

      // Can't increase position with reduceOnly
      const isLong = gt(currentSzi, '0');
      if ((isLong && order.isBuy) || (!isLong && !order.isBuy)) return;

      // Clamp fill size to position size
      const posAbs = abs(currentSzi);
      if (gt(fillSz, posAbs)) {
        // Reduce fill to exactly close the position
        return this.executeFillWithSize(order, fillPx, posAbs, currentSzi, currentEntryPx, isTaker);
      }
    }

    await this.executeFillWithSize(order, fillPx, fillSz, currentSzi, currentEntryPx, isTaker);
  }

  private async executeFillWithSize(
    order: PaperOrder,
    fillPx: string,
    fillSz: string,
    currentSzi: string,
    currentEntryPx: string,
    isTaker: boolean = true,
  ): Promise<void> {
    const userId = order.userId;
    const asset = order.asset;
    const signedFillSz = order.isBuy ? fillSz : neg(fillSz);
    const newSzi = add(currentSzi, signedFillSz);

    // Calculate new entry price (weighted average)
    let newEntryPx: string;
    let closedPnl = '0';

    const isCurrentLong = gt(currentSzi, '0');
    const isCurrentShort = lt(currentSzi, '0');
    const isIncreasing =
      (isCurrentLong && order.isBuy) ||
      (isCurrentShort && !order.isBuy) ||
      isZero(currentSzi);

    if (isIncreasing) {
      // Increasing position: weighted average entry
      if (isZero(currentSzi)) {
        newEntryPx = fillPx;
      } else {
        const currentNotional = mul(abs(currentSzi), currentEntryPx);
        const fillNotional = mul(fillSz, fillPx);
        const totalSz = add(abs(currentSzi), fillSz);
        newEntryPx = D(add(currentNotional, fillNotional)).div(D(totalSz)).toString();
      }
    } else {
      // Reducing/closing/flipping position
      const closingSz = min(fillSz, abs(currentSzi));

      // PnL on closed portion
      if (isCurrentLong) {
        closedPnl = mul(sub(fillPx, currentEntryPx), closingSz);
      } else {
        closedPnl = mul(sub(currentEntryPx, fillPx), closingSz);
      }

      // If flipping, new entry is fill price for the remainder
      if (gt(fillSz, abs(currentSzi))) {
        newEntryPx = fillPx;
      } else {
        newEntryPx = currentEntryPx;
      }
    }

    const tid = await nextTid();
    const now = Date.now();

    // Determine fill direction string
    const dir = this.getFillDir(currentSzi, signedFillSz);

    // Calculate fee. Builder fees from HL's order `{builder:{b,f}}` sub-
    // object are bundled into the same `fee` field — `f` is in tenths of a
    // basis point, so the rate is `f / 1_000_000`. Builder fees only apply
    // to the taker side, matching HL's behavior; the maker pays the
    // exchange maker rate alone. When fees are globally disabled
    // (FEES_ENABLED=false) the builder fee is also skipped — the toggle is
    // meant to make paper books frictionless during dev.
    const exchangeFeeRate = config.FEES_ENABLED
      ? (isTaker ? config.FEE_RATE_TAKER : config.FEE_RATE_MAKER)
      : '0';
    const notional = mul(fillSz, fillPx);
    const exchangeFee = mul(notional, exchangeFeeRate);
    const builderFee = (config.FEES_ENABLED && isTaker && order.builder)
      ? mul(notional, (order.builder.f / 1_000_000).toString())
      : '0';
    const fee = add(exchangeFee, builderFee);

    const fill: PaperFill = {
      coin: order.coin,
      px: fillPx,
      sz: fillSz,
      side: order.isBuy ? 'B' : 'A',
      time: now,
      startPosition: currentSzi,
      dir,
      closedPnl,
      hash: `0x${tid.toString(16).padStart(64, '0')}`,
      oid: order.oid,
      crossed: isTaker,
      fee,
      tid,
      cloid: order.cloid,
      feeToken: 'USDC',
      // HL prod always emits twapId on userFills entries; null for non-TWAP
      // fills (every fill HyPaper produces, since HyPaper has no TWAP path).
      twapId: null,
    };

    // Pre-read funding fields before pipeline
    let cumFunding = '0';
    let cumFundingSinceOpen = '0';
    if (!isZero(newSzi)) {
      const posKey = KEYS.USER_POS(userId, asset);
      cumFunding = (await redis.hget(posKey, 'cumFunding')) ?? '0';
      if (!isZero(currentSzi)) {
        cumFundingSinceOpen = (await redis.hget(posKey, 'cumFundingSinceOpen')) ?? '0';
      }
    }

    // Sub-dex scope for this fill (xyz, flx, …) or '' for native. Determines
    // which USER_POSITIONS set the asset belongs to and which balance field
    // PnL + fees write to. Each sub-dex is its own subaccount on HL.
    const { scopeForAsset } = await import('../engine/order.js');
    const scope = await scopeForAsset(asset);

    // Atomic pipeline
    const pipeline = redis.pipeline();

    // Update position
    if (isZero(newSzi)) {
      // Position fully closed
      pipeline.del(KEYS.USER_POS(userId, asset));
      pipeline.srem(KEYS.USER_POSITIONS_SCOPED(userId, scope), asset.toString());
    } else {
      pipeline.hset(KEYS.USER_POS(userId, asset),
        'userId', userId,
        'asset', asset.toString(),
        'coin', order.coin,
        'szi', newSzi,
        'entryPx', newEntryPx,
        'cumFunding', cumFunding,
        'cumFundingSinceOpen', cumFundingSinceOpen,
        'cumFundingSinceChange', '0',
      );
      pipeline.sadd(KEYS.USER_POSITIONS_SCOPED(userId, scope), asset.toString());
    }

    // Track active user for funding
    pipeline.sadd(KEYS.USERS_ACTIVE, userId);

    // Credit closed PnL to scoped balance field. Native: 'balance'. Sub-dex:
    // 'balance:xyz' / 'balance:flx' / etc. — each subaccount is independent.
    const balField = KEYS.USER_BAL_FIELD(scope);
    if (!isZero(closedPnl)) {
      pipeline.hincrbyfloat(KEYS.USER_ACCOUNT(userId), balField, closedPnl);
    }

    // Deduct fee from scoped balance field.
    if (!isZero(fee)) {
      pipeline.hincrbyfloat(KEYS.USER_ACCOUNT(userId), balField, neg(fee));
    }

    // Mark order as filled
    pipeline.hset(KEYS.ORDER(order.oid),
      'status', 'filled',
      'filledSz', order.sz,
      'avgPx', fillPx,
      'updatedAt', now.toString(),
    );

    // Remove from open/trigger sets
    pipeline.srem(KEYS.ORDERS_OPEN, order.oid.toString());
    pipeline.srem(KEYS.ORDERS_TRIGGERS, order.oid.toString());

    // Push fill
    pipeline.lpush(KEYS.USER_FILLS(userId), JSON.stringify(fill));

    await pipeline.exec();

    logger.info({
      oid: order.oid,
      coin: order.coin,
      side: order.isBuy ? 'buy' : 'sell',
      sz: fillSz,
      px: fillPx,
      closedPnl,
      newSzi,
    }, 'Order filled');

    this.eventBus.emit('orderUpdate', {
      userId,
      order: { ...order, status: 'filled' as const, filledSz: order.sz, avgPx: fillPx, updatedAt: now },
      status: 'filled',
    });
    this.eventBus.emit('fill', { userId, fill });

    // Bracket OCO: when one sibling fills, cancel the rest. HL's
    // `normalTpsl` / `positionTpsl` groupings link orders so a TP fill
    // auto-cancels its SL counterpart (and vice versa).
    await this.cancelOrderSiblings(order.oid, userId);
  }

  /** Bracket cascade on fill. Two cases:
   *    1. THIS oid is a PARENT (has CHILDREN registered) → fill it and
   *       LEAVE children alive. Children now bracket the new position.
   *    2. THIS oid is a CHILD (has BRACKET siblings registered) → cancel
   *       sibling children (OCO: only one exit fires) and clean parent's
   *       children-set so a later parent-cancel doesn't try to re-cancel
   *       already-filled / already-cancelled legs.
   *    3. Unlinked order → no-op.
   */
  private async cancelOrderSiblings(oid: number, userId: string): Promise<void> {
    // Case 1: parent fill — children stay alive. Just clean the children
    // set and the children's reverse pointers since the parent is gone.
    const childrenOids = await redis.smembers(KEYS.ORDER_CHILDREN(oid));
    if (childrenOids.length > 0) {
      const pipeline = redis.pipeline();
      pipeline.del(KEYS.ORDER_CHILDREN(oid));
      for (const childStr of childrenOids) {
        const childOid = parseInt(childStr, 10);
        if (Number.isFinite(childOid)) pipeline.del(KEYS.ORDER_PARENT(childOid));
      }
      await pipeline.exec();
      return;
    }

    // Case 2/3: this oid is a child (or unlinked). Walk its sibling set.
    const siblings = await redis.smembers(KEYS.ORDER_BRACKET(oid));
    if (siblings.length === 0) {
      // Unlinked or already drained — nothing to do.
      await redis.del(KEYS.ORDER_PARENT(oid));
      return;
    }
    // Pull the parent so we can clean its children-set too.
    const parentStr = await redis.get(KEYS.ORDER_PARENT(oid));
    const parentOid = parentStr ? parseInt(parentStr, 10) : null;
    await redis.del(KEYS.ORDER_BRACKET(oid));
    await redis.del(KEYS.ORDER_PARENT(oid));
    if (parentOid && Number.isFinite(parentOid)) {
      await redis.srem(KEYS.ORDER_CHILDREN(parentOid), oid.toString());
    }
    for (const sibStr of siblings) {
      const sibOid = parseInt(sibStr, 10);
      if (!Number.isFinite(sibOid)) continue;
      const sibData = await redis.hgetall(KEYS.ORDER(sibOid));
      if (!sibData.oid || sibData.status !== 'open') continue;
      const now = Date.now();
      const pipeline = redis.pipeline();
      pipeline.hset(KEYS.ORDER(sibOid), 'status', 'cancelled', 'updatedAt', now.toString());
      pipeline.srem(KEYS.ORDERS_OPEN, sibStr);
      pipeline.srem(KEYS.ORDERS_TRIGGERS, sibStr);
      pipeline.del(KEYS.ORDER_BRACKET(sibOid));
      pipeline.del(KEYS.ORDER_PARENT(sibOid));
      if (parentOid && Number.isFinite(parentOid)) pipeline.srem(KEYS.ORDER_CHILDREN(parentOid), sibStr);
      await pipeline.exec();
      this.eventBus.emit('orderUpdate', {
        userId,
        order: {
          oid: sibOid,
          coin: sibData.coin,
          isBuy: sibData.isBuy === 'true',
          sz: sibData.sz,
          limitPx: sibData.limitPx,
          status: 'cancelled' as const,
          asset: parseInt(sibData.asset, 10),
          userId,
          orderType: (sibData.orderType ?? 'limit') as 'limit' | 'trigger',
          tif: (sibData.tif ?? 'Gtc') as 'Gtc' | 'Ioc' | 'Alo',
          reduceOnly: sibData.reduceOnly === 'true',
          grouping: (sibData.grouping ?? 'na') as 'na' | 'normalTpsl' | 'positionTpsl',
          filledSz: sibData.filledSz ?? '0',
          avgPx: sibData.avgPx ?? '0',
          createdAt: parseInt(sibData.createdAt, 10),
          updatedAt: now,
          cloid: sibData.cloid || undefined,
        } as PaperOrder,
        status: 'cancelled',
      });
    }
  }

  private getFillDir(startPosition: string, signedFillSz: string): string {
    const newPos = add(startPosition, signedFillSz);
    if (isZero(startPosition)) {
      return gt(signedFillSz, '0') ? 'Open Long' : 'Open Short';
    }
    if (isZero(newPos)) {
      return gt(startPosition, '0') ? 'Close Long' : 'Close Short';
    }
    const wasLong = gt(startPosition, '0');
    const isBuy = gt(signedFillSz, '0');
    if (wasLong && isBuy) return 'Buy';
    if (wasLong && !isBuy) return 'Sell';
    if (!wasLong && isBuy) return 'Buy';
    return 'Sell';
  }

  private parseOrder(data: Record<string, string>): PaperOrder {
    // Builder code (HL's order `{builder: {b,f}}` sub-object) is persisted
    // as JSON in `saveOrder`; deserialize back so executeFill can apply the
    // bundled exchange+builder fee. Malformed entries are ignored — the
    // worst case is a missed builder fee on this fill.
    let builder: { b: string; f: number } | undefined;
    if (data.builder) {
      try {
        const parsed = JSON.parse(data.builder);
        if (parsed && typeof parsed.b === 'string' && typeof parsed.f === 'number') {
          builder = { b: parsed.b, f: parsed.f };
        }
      } catch { /* ignore — treat as no builder */ }
    }
    return {
      oid: parseInt(data.oid, 10),
      cloid: data.cloid || undefined,
      userId: data.userId,
      asset: parseInt(data.asset, 10),
      coin: data.coin,
      isBuy: data.isBuy === 'true',
      sz: data.sz,
      limitPx: data.limitPx,
      orderType: data.orderType as 'limit' | 'trigger',
      tif: data.tif as 'Gtc' | 'Ioc' | 'Alo',
      reduceOnly: data.reduceOnly === 'true',
      triggerPx: data.triggerPx || undefined,
      tpsl: (data.tpsl as 'tp' | 'sl') || undefined,
      isMarket: data.isMarket === 'true',
      grouping: data.grouping as 'na' | 'normalTpsl' | 'positionTpsl',
      status: data.status as PaperOrder['status'],
      filledSz: data.filledSz ?? '0',
      avgPx: data.avgPx ?? '0',
      createdAt: parseInt(data.createdAt, 10),
      updatedAt: parseInt(data.updatedAt, 10),
      ...(builder ? { builder } : {}),
    };
  }
}
