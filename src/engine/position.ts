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
    const liqPx = calculateLiquidationPrice(pos.szi, pos.entryPx, accountValue, leverage);

    const roe = isZero(marginUsed)
      ? '0'
      : div(unrealizedPnl, marginUsed);

    const maxLeverage = meta?.universe[asset]?.maxLeverage ?? 50;

    totalNtlPos = D(totalNtlPos).plus(D(posValue)).toString();
    totalMarginUsed = D(totalMarginUsed).plus(D(marginUsed)).toString();
    totalUnrealizedPnl = D(totalUnrealizedPnl).plus(D(unrealizedPnl)).toString();

    assetPositions.push({
      type: 'oneWay',
      position: {
        coin,
        szi: pos.szi,
        entryPx: pos.entryPx,
        positionValue: posValue,
        unrealizedPnl,
        returnOnEquity: roe,
        liquidationPx: liqPx,
        leverage: {
          type: isCross ? 'cross' : 'isolated',
          value: leverage,
        },
        cumFunding: {
          allTime: pos.cumFunding ?? '0',
          sinceOpen: pos.cumFundingSinceOpen ?? '0',
          sinceChange: pos.cumFundingSinceChange ?? '0',
        },
        maxLeverage,
        marginUsed,
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

    orders.push({
      coin: data.coin,
      side: data.isBuy === 'true' ? 'B' : 'A',
      limitPx: data.limitPx,
      sz: data.sz,
      oid,
      timestamp: parseInt(data.createdAt, 10),
      origSz: data.sz,
      cloid: data.cloid || undefined,
    });
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

    const isTrigger = data.orderType === 'trigger';
    orders.push({
      coin: data.coin,
      side: data.isBuy === 'true' ? 'B' : 'A',
      limitPx: data.limitPx,
      sz: data.sz,
      oid,
      timestamp: parseInt(data.createdAt, 10),
      origSz: data.sz,
      cloid: data.cloid || undefined,
      tif: data.tif,
      // Match HL-prod's FrontendOrderInfo shape exactly so consumers
      // (e.g. slushy's auto-position-overlay classifier) can use the
      // same detection rules against either backend. Reference:
      // hyperliquid-rust-sdk/src/info/sub_structs.rs `BasicOrderInfo`.
      // Previously HyPaper omitted `isTrigger` and collapsed every
      // trigger order's orderType to "Stop" — both diverged from HL,
      // which broke the bracket detector silently in paper mode.
      isTrigger,
      orderType: hlOrderTypeString(isTrigger, data.tpsl, data.isMarket === 'true'),
      triggerPx: data.triggerPx || undefined,
      triggerCondition: data.tpsl || undefined,
      isPositionTpsl: data.grouping === 'positionTpsl',
      reduceOnly: data.reduceOnly === 'true',
    });
  }

  return orders;
}

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

  return {
    status: 'order',
    order: {
      coin: data.coin,
      side: data.isBuy === 'true' ? 'B' : 'A',
      limitPx: data.limitPx,
      sz: data.sz,
      oid: parseInt(data.oid, 10),
      timestamp: parseInt(data.createdAt, 10),
      origSz: data.sz,
      cloid: data.cloid || undefined,
      tif: data.tif,
      orderType: data.orderType === 'trigger' ? 'Stop' : 'Limit',
      triggerPx: data.triggerPx || undefined,
      triggerCondition: data.tpsl || undefined,
      isPositionTpsl: data.grouping === 'positionTpsl',
      reduceOnly: data.reduceOnly === 'true',
      status: data.status,
      statusTimestamp: parseInt(data.updatedAt, 10),
    },
  };
}
