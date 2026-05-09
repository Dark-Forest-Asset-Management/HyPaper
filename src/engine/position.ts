import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import {
  calculateAccountValue,
  getBalance,
  calculateTotalUnrealizedPnl,
  calculateTotalMarginUsed,
  calculatePositionUnrealizedPnl,
  calculatePositionMarginUsed,
  calculateLiquidationPrice,
} from './margin.js';
import { abs, sub, mul, div, isZero, gt, D } from '../utils/math.js';
import type { HlClearinghouseState, HlAssetPosition, HlMeta } from '../types/hl.js';

export async function getClearinghouseState(userId: string): Promise<HlClearinghouseState> {
  const balance = await getBalance(userId);
  const positionAssets = await redis.smembers(KEYS.USER_POSITIONS(userId));
  const mids = await redis.hgetall(KEYS.MARKET_MIDS);
  const metaRaw = await redis.get(KEYS.MARKET_META);
  const meta: HlMeta | null = metaRaw ? JSON.parse(metaRaw) : null;

  const assetPositions: HlAssetPosition[] = [];
  let totalNtlPos = '0';
  let totalMarginUsed = '0';
  let totalUnrealizedPnl = '0';

  for (const assetStr of positionAssets) {
    const asset = parseInt(assetStr, 10);
    const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
    if (!pos.szi || isZero(pos.szi)) continue;

    const coin = pos.coin;
    const midPx = mids[coin];
    if (!midPx) continue;

    const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
    const leverage = lev.leverage ? parseInt(lev.leverage, 10) : 20;
    const isCross = lev.isCross !== 'false';

    const posValue = mul(abs(pos.szi), midPx);
    const unrealizedPnl = calculatePositionUnrealizedPnl(pos.szi, pos.entryPx, midPx);
    const marginUsed = await calculatePositionMarginUsed(userId, asset, pos.szi, midPx);

    const accountValue = await calculateAccountValue(userId);
    const liqPx = calculateLiquidationPrice(pos.szi, pos.entryPx, accountValue, leverage, isCross);

    const roe = isZero(marginUsed)
      ? '0'
      : div(unrealizedPnl, marginUsed);

    const maxLeverage = meta?.universe[asset]?.maxLeverage ?? 50;

    totalNtlPos = D(totalNtlPos).plus(D(posValue)).toString();
    totalMarginUsed = D(totalMarginUsed).plus(D(marginUsed)).toString();
    totalUnrealizedPnl = D(totalUnrealizedPnl).plus(D(unrealizedPnl)).toString();

    // Field order mirrors HL prod /info clearinghouseState response,
    // captured 2026-05-09T16-51-39 from open-hl-bracket.ts on XRP perp.
    // HL emits: coin, szi, leverage, entryPx, positionValue, unrealizedPnl,
    // returnOnEquity, liquidationPx, marginUsed, maxLeverage, cumFunding.
    assetPositions.push({
      type: 'oneWay',
      position: {
        coin,
        szi: pos.szi,
        leverage: {
          type: isCross ? 'cross' : 'isolated',
          value: leverage,
        },
        entryPx: pos.entryPx,
        positionValue: posValue,
        unrealizedPnl,
        returnOnEquity: roe,
        liquidationPx: liqPx,
        marginUsed,
        maxLeverage,
        cumFunding: {
          allTime: pos.cumFunding ?? '0',
          sinceOpen: pos.cumFundingSinceOpen ?? '0',
          sinceChange: pos.cumFundingSinceChange ?? '0',
        },
      },
    });
  }

  const accountValue = D(balance).plus(D(totalUnrealizedPnl)).toString();
  const withdrawable = sub(accountValue, totalMarginUsed);

  return {
    assetPositions,
    crossMarginSummary: {
      accountValue,
      totalNtlPos,
      totalRawUsd: balance,
      totalMarginUsed,
    },
    marginSummary: {
      accountValue,
      totalNtlPos,
      totalRawUsd: balance,
      totalMarginUsed,
    },
    crossMaintenanceMarginUsed: div(totalMarginUsed, '2'),
    withdrawable: gt(withdrawable, '0') ? withdrawable : '0',
    time: Date.now(),
  };
}

export async function getOpenOrders(userId: string) {
  const oids = await redis.zrange(KEYS.USER_ORDERS(userId), 0, -1);
  const orders = [];

  for (const oidStr of oids) {
    const oid = parseInt(oidStr, 10);
    const data = await redis.hgetall(KEYS.ORDER(oid));
    if (!data.oid || data.status !== 'open') continue;

    // HL prod /info openOrders shape, captured 2026-05-09: each entry has
    // exactly these 8 fields — coin, side, limitPx, sz, oid, timestamp,
    // origSz, reduceOnly. `cloid` is omitted entirely when not set (HL
    // does NOT emit cloid: null on basic openOrders, only on the richer
    // frontendOpenOrders response). Field order matches HL.
    const entry: {
      coin: string; side: 'A' | 'B'; limitPx: string; sz: string;
      oid: number; timestamp: number; origSz: string; reduceOnly: boolean;
      cloid?: string;
    } = {
      coin: data.coin,
      side: data.isBuy === 'true' ? 'B' : 'A',
      limitPx: data.limitPx,
      sz: data.sz,
      oid,
      timestamp: parseInt(data.createdAt, 10),
      origSz: data.sz,
      reduceOnly: data.reduceOnly === 'true',
    };
    if (data.cloid) entry.cloid = data.cloid;
    orders.push(entry);
  }

  return orders;
}

export async function getFrontendOpenOrders(userId: string) {
  const oids = await redis.zrange(KEYS.USER_ORDERS(userId), 0, -1);
  const orders = [];

  for (const oidStr of oids) {
    const oid = parseInt(oidStr, 10);
    const data = await redis.hgetall(KEYS.ORDER(oid));
    if (!data.oid || data.status !== 'open') continue;

    // Field order, types, and explicit-null vs omit semantics mirror
    // HL prod /info frontendOpenOrders. Ground truth captured by
    // black-owl-app/test-scripts/open-hl-bracket.ts on 2026-05-09 against
    // a normalTpsl bracket on XRP — both TP (oid 418261286181) and SL
    // (oid 418261286182) entries show this exact field layout, with
    // `tif: null`, `cloid: null`, `children: []`, and a prose
    // `triggerCondition` string ("Price above 1.4379" / "Price below 1.3991").
    const isTrigger = data.orderType === 'trigger';
    const isBuy = data.isBuy === 'true';
    const triggerPx = data.triggerPx || '0.0';
    orders.push({
      coin: data.coin,
      side: isBuy ? 'B' : 'A',
      limitPx: data.limitPx,
      sz: data.sz,
      oid,
      timestamp: parseInt(data.createdAt, 10),
      triggerCondition: isTrigger
        ? hlTriggerConditionString(data.tpsl, isBuy, triggerPx)
        : 'N/A',
      isTrigger,
      triggerPx,
      children: [] as Array<{ oid: number; triggerPx: string; tpsl: 'tp' | 'sl' }>,
      isPositionTpsl: data.grouping === 'positionTpsl',
      reduceOnly: data.reduceOnly === 'true',
      orderType: hlOrderTypeString(isTrigger, data.tpsl, data.isMarket === 'true'),
      origSz: data.sz,
      tif: data.tif ?? null,
      cloid: data.cloid || null,
    });
  }

  return orders;
}

/** Build the human-readable trigger-condition prose HL emits in
 *  frontendOpenOrders. Verified against HL prod for a normalTpsl bracket
 *  on a long XRP position:
 *    side='A' + tpsl='tp' + triggerPx=1.4379 → "Price above 1.4379"
 *    side='A' + tpsl='sl' + triggerPx=1.3991 → "Price below 1.3991"
 *  Direction rule: trigger fires "above" when the trigger order is a sell
 *  (closing long) on TP, or a buy (closing short) on SL — i.e., when
 *  `(tpsl === 'tp') !== isBuy`. Exported so pg-queries.ts can build the
 *  same prose for historicalOrders responses. */
export function hlTriggerConditionString(
  tpsl: string | undefined | null,
  isBuy: boolean,
  triggerPx: string,
): string {
  if (tpsl !== 'tp' && tpsl !== 'sl') return 'N/A';
  const direction = ((tpsl === 'tp') !== isBuy) ? 'above' : 'below';
  return `Price ${direction} ${triggerPx}`;
}

/** Same hlOrderTypeString from this file but exported for pg-queries to
 *  reuse — historicalOrders needs the same "Stop Market" / "Take Profit
 *  Market" / "Limit" strings HL prod emits. */
export { hlOrderTypeString };

/** HL FrontendOrderInfo orderType strings. `Limit` for non-trigger, four
 *  trigger variants by (tp|sl) × (market|limit). Cross-checked against
 *  the gitbook example responses + python-sdk basic_tpsl example. */
function hlOrderTypeString(isTrigger: boolean, tpsl: string | undefined, isMarket: boolean): string {
  if (!isTrigger) return 'Limit';
  if (tpsl === 'tp') return isMarket ? 'Take Profit Market' : 'Take Profit Limit';
  if (tpsl === 'sl') return isMarket ? 'Stop Market' : 'Stop Limit';
  // Trigger order without an explicit tpsl tag — fall back to the
  // generic name HL uses pre-classification.
  return isMarket ? 'Stop Market' : 'Stop Limit';
}

export async function getOrderStatus(oid: number) {
  const data = await redis.hgetall(KEYS.ORDER(oid));
  if (!data.oid) {
    return { status: 'unknownOid' };
  }

  // HL prod /info orderStatus uses a NESTED structure, captured 2026-05-09
  // against oid 418261286180 (filled XRP entry):
  //   { status: 'order',
  //     order: {
  //       order: { ...same fields as historicalOrders },
  //       status: 'filled',
  //       statusTimestamp: <ms>
  //     }
  //   }
  // Note the double `order` — outer wraps the historicalOrder-shaped
  // entry. Previously HyPaper FLATTENED status/statusTimestamp into the
  // inner order object, which broke any client that round-tripped the
  // shape between HL prod and HyPaper. Also normalize `cancelled` (UK)
  // to `canceled` (US) the same way getHistoricalOrdersPg does so the
  // status string matches HL.
  const isTrigger = data.orderType === 'trigger';
  const isBuy = data.isBuy === 'true';
  const triggerPx = data.triggerPx || '0.0';
  return {
    status: 'order',
    order: {
      order: {
        coin: data.coin,
        side: isBuy ? 'B' : 'A',
        limitPx: data.limitPx,
        sz: data.sz,
        oid: parseInt(data.oid, 10),
        timestamp: parseInt(data.createdAt, 10),
        triggerCondition: isTrigger
          ? hlTriggerConditionString(data.tpsl, isBuy, triggerPx)
          : 'N/A',
        isTrigger,
        triggerPx,
        children: [] as Array<{ oid: number; triggerPx: string; tpsl: 'tp' | 'sl' }>,
        isPositionTpsl: data.grouping === 'positionTpsl',
        reduceOnly: data.reduceOnly === 'true',
        orderType: hlOrderTypeString(isTrigger, data.tpsl, data.isMarket === 'true'),
        origSz: data.sz,
        tif: isTrigger ? null : data.tif,
        cloid: data.cloid || null,
      },
      status: data.status === 'cancelled' ? 'canceled' : data.status,
      statusTimestamp: parseInt(data.updatedAt, 10),
    },
  };
}
