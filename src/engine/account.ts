/**
 * Account-state info endpoints served from paper state (Phase 1.1):
 *   portfolio, userFees, userRateLimit, activeAssetData.
 *
 * These describe the SIMULATED account, so they must be served locally (never
 * proxied — see info.ts user-gate). Shapes verified against HL mainnet goldens
 * in scripts/captures/ (12_portfolio, 13_userFees, 15_userRateLimit,
 * 16_activeAssetData).
 */

import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getClearinghouseState } from './position.js';
import { getNetDepositsPg, getVolumeSincePg } from '../store/pg-queries.js';
import { D, mul, div } from '../utils/math.js';
import type { HlMeta } from '../types/hl.js';

// ── portfolio ──────────────────────────────────────────────────────────────

const PERIODS: Array<{ name: string; windowMs: number | null }> = [
  { name: 'day', windowMs: 86_400_000 },
  { name: 'week', windowMs: 604_800_000 },
  { name: 'month', windowMs: 2_592_000_000 },
  { name: 'allTime', windowMs: null },
  // Paper is perp-centric; perp* mirror the overall periods until spot PnL
  // is tracked separately (Phase 4).
  { name: 'perpDay', windowMs: 86_400_000 },
  { name: 'perpWeek', windowMs: 604_800_000 },
  { name: 'perpMonth', windowMs: 2_592_000_000 },
  { name: 'perpAllTime', windowMs: null },
];

interface PortfolioPeriod {
  accountValueHistory: Array<[number, string]>;
  pnlHistory: Array<[number, string]>;
  vlm: string;
}

/** Append the current account-value/PnL point, then build HL's 8-period
 *  portfolio. History grows organically as the endpoint is polled; a worker
 *  timer (snapshotPortfolios) keeps it ticking for active accounts too. */
export async function getPortfolio(userId: string): Promise<Array<[string, PortfolioPeriod]>> {
  const now = Date.now();
  await appendPortfolioSnapshot(userId, now);

  const raw = await redis.zrange(KEYS.USER_AVHIST(userId), 0, -1, 'WITHSCORES');
  const points: Array<{ t: number; av: string; pnl: string }> = [];
  for (let i = 0; i < raw.length; i += 2) {
    const [t, av, pnl] = raw[i].split(':');
    points.push({ t: Number(t), av, pnl });
  }

  const out: Array<[string, PortfolioPeriod]> = [];
  for (const { name, windowMs } of PERIODS) {
    const since = windowMs === null ? 0 : now - windowMs;
    const inWindow = points.filter((p) => p.t >= since);
    out.push([name, {
      accountValueHistory: inWindow.map((p) => [p.t, p.av] as [number, string]),
      pnlHistory: inWindow.map((p) => [p.t, p.pnl] as [number, string]),
      vlm: await getVolumeSincePg(userId, since),
    }]);
  }
  return out;
}

async function appendPortfolioSnapshot(userId: string, now: number): Promise<void> {
  try {
    const state = await getClearinghouseState(userId);
    const av = state.marginSummary.accountValue;
    const netDeposits = await getNetDepositsPg(userId);
    const pnl = D(av).minus(D(netDeposits)).toString();
    await redis.zadd(KEYS.USER_AVHIST(userId), now, `${now}:${av}:${pnl}`);
  } catch (err) {
    logger.warn({ err, userId }, 'portfolio snapshot append failed');
  }
}

/** Periodic snapshot for active accounts so history accrues without polling. */
export async function snapshotPortfolios(): Promise<void> {
  const users = await redis.smembers(KEYS.USERS_ACTIVE);
  const now = Date.now();
  for (const u of users) await appendPortfolioSnapshot(u, now);
}

// ── userRateLimit ────────────────────────────────────────────────────────

export async function getUserRateLimit(userId: string): Promise<{
  cumVlm: string; nRequestsUsed: number; nRequestsCap: number; nRequestsSurplus: number;
}> {
  const cumVlm = await getVolumeSincePg(userId, 0);
  // HL caps requests at ~1 per 1 USDC traded (min 10k). Paper mirrors the
  // shape; request accounting isn't enforced, so used=0.
  const cap = Math.max(10_000, Math.floor(Number(cumVlm)));
  return { cumVlm, nRequestsUsed: 0, nRequestsCap: cap, nRequestsSurplus: 0 };
}

// ── userFees ───────────────────────────────────────────────────────────────

// HL's feeSchedule is GLOBAL (identical for every account) — fetch once and
// cache. Only the user-specific fields (rates, dailyUserVlm, discounts) are
// paper-computed.
let cachedFeeSchedule: unknown = null;
let feeScheduleExpiry = 0;
const FEE_SCHEDULE_TTL = 3_600_000; // 1h

async function getGlobalFeeSchedule(): Promise<unknown> {
  if (cachedFeeSchedule && feeScheduleExpiry > Date.now()) return cachedFeeSchedule;
  try {
    const res = await fetch(`${config.HL_API_URL}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Any address returns the same global feeSchedule sub-object.
      body: JSON.stringify({ type: 'userFees', user: '0x0000000000000000000000000000000000000001' }),
    });
    const data = await res.json() as { feeSchedule?: unknown };
    if (data?.feeSchedule) {
      cachedFeeSchedule = data.feeSchedule;
      feeScheduleExpiry = Date.now() + FEE_SCHEDULE_TTL;
    }
  } catch (err) {
    logger.warn({ err }, 'failed to fetch global feeSchedule');
  }
  return cachedFeeSchedule;
}

export async function getUserFees(userId: string): Promise<Record<string, unknown>> {
  const feeSchedule = await getGlobalFeeSchedule();
  // Paper daily volume — one entry for today (HL emits a dated series).
  const cumVlm = await getVolumeSincePg(userId, 0);
  const today = new Date().toISOString().slice(0, 10);
  const dailyUserVlm = [{ date: today, userCross: cumVlm, userAdd: '0.0', exchange: '0.0' }];
  return {
    dailyUserVlm,
    feeSchedule,
    userCrossRate: config.FEE_RATE_TAKER,
    userAddRate: config.FEE_RATE_MAKER,
    userSpotCrossRate: config.FEE_RATE_TAKER,
    userSpotAddRate: config.FEE_RATE_MAKER,
    activeReferralDiscount: '0.0',
    trial: null,
    feeTrialEscrow: '0.0',
    nextTrialAvailableTimestamp: null,
    stakingLink: null,
    activeStakingDiscount: { bpsOfMaxSupply: '0.0', discount: '0.0' },
  };
}

// ── activeAssetData ──────────────────────────────────────────────────────

/** Resolve a coin name → main-DEX asset index (perp universe). */
async function assetIndexForCoin(coin: string): Promise<number> {
  const metaRaw = await redis.get(KEYS.MARKET_META);
  if (!metaRaw) return -1;
  const meta: HlMeta = JSON.parse(metaRaw);
  return meta.universe.findIndex((u) => u.name === coin);
}

export async function getActiveAssetData(userId: string, coin: string): Promise<{
  user: string; coin: string; leverage: { type: 'cross' | 'isolated'; value: number };
  maxTradeSzs: [string, string]; availableToTrade: [string, string]; markPx: string;
}> {
  const asset = await assetIndexForCoin(coin);
  const lev = asset >= 0 ? await redis.hgetall(KEYS.USER_LEV(userId, asset)) : {};
  const leverage = lev.leverage ? parseInt(lev.leverage, 10) : 20;
  const isCross = lev.isCross !== 'false';

  const ctx = await redis.hgetall(KEYS.MARKET_CTX(coin));
  const markPx = ctx.markPx || (await redis.hget(KEYS.MARKET_MIDS, coin)) || '0';

  const state = await getClearinghouseState(userId);
  const avail = state.withdrawable;
  // maxTradeSz = availableUsd × leverage / markPx (matches HL golden math).
  const maxSz = Number(markPx) > 0
    ? div(mul(avail, leverage.toString()), markPx)
    : '0';

  return {
    user: userId,
    coin,
    leverage: { type: isCross ? 'cross' : 'isolated', value: leverage },
    maxTradeSzs: [maxSz, maxSz],
    availableToTrade: [avail, avail],
    markPx,
  };
}
