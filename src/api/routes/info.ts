import { Hono } from 'hono';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { config } from '../../config.js';
import { getClearinghouseState, getOpenOrders, getFrontendOpenOrders, getOrderStatus } from '../../engine/position.js';
import { getUserFills, getUserFillsByTime } from '../../engine/fill.js';
import { getHistoricalOrdersPg, getUserFundingPg, getLedgerUpdatesPg } from '../../store/pg-queries.js';
import { getPortfolio, getUserFees, getUserRateLimit, getActiveAssetData } from '../../engine/account.js';
import { logger } from '../../utils/logger.js';
import { ensureAccount } from '../middleware/auth.js';

export const infoRouter = new Hono();

// --- Proxy cache ---

interface CacheEntry {
  data: unknown;
  expiry: number;
}

// TTL per proxied type (ms)
const PROXY_TTL: Record<string, number> = {
  meta: 60_000,
  metaAndAssetCtxs: 2_000,
  l2Book: 1_000,
  candleSnapshot: 5_000,
  fundingHistory: 30_000,
  perpsAtOpenInterest: 10_000,
  predictedFundings: 10_000,
};

const DEFAULT_PROXY_TTL = 5_000;
const proxyCache = new Map<string, CacheEntry>();

function getCacheKey(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

// Market/reference endpoints we always proxy to real HL (not user-scoped).
const PROXIED_TYPES = new Set(Object.keys(PROXY_TTL));

// ── User-scoped routing gate (the paper-mode invariant) ──────────────────
// HyPaper IS the paper backend, so a request that names a `user` (or
// `vaultAddress` / `oid`) describes the SIMULATED account. Proxying such a
// read to live HL would pollute the paper view with the wallet's real
// on-chain state — the exact bug slushy already hit on the WS side
// (hlClient.ts:26-39). So: user-scoped reads are NEVER proxied unless they
// have no paper equivalent (PROXY_ANYWAY_USER_TYPES). Anything else falls
// back to a correctly-typed empty + a warn, never live data.

/** A request targets simulated account state if it carries any of these. */
function isUserScoped(body: Record<string, unknown>): boolean {
  return body.user !== undefined
    || body.vaultAddress !== undefined
    || body.oid !== undefined;
}

// User-scoped info types with NO paper-state equivalent yet, deliberately
// passed through to live HL until their dedicated epic lands. As each is
// implemented as a local `case` (Phase 1-4), REMOVE it here. Passthrough
// for these (staking/vaults/referral/spot-balances/etc.) is the lesser evil
// vs returning empty for data the sim doesn't model. A real wallet's role is
// "user" and its rate-limit is real, so those are harmless to passthrough.
const PROXY_ANYWAY_USER_TYPES = new Set<string>([
  'spotClearinghouseState',
  'delegations', 'delegatorSummary', 'delegatorHistory', 'delegatorRewards',
  'vaultDetails', 'userVaultEquities',
  'referral', 'subAccounts', 'extraAgents',
  'maxBuilderFee', 'builderFeeApproval',
  'userToMultiSigSigners', 'legalCheck', 'isVip', 'preTransferCheck',
  'userAbstraction', 'userDexAbstraction',
]);

// User-scoped types we intend to serve from paper state but haven't
// implemented yet. Until then they fail safe to a typed empty so the paper
// account is never polluted with real on-chain history. Object-shaped
// responses are listed here; everything else defaults to an empty array
// (most HL user history endpoints are arrays). Phase 3 will add
// userTwapSliceFills / twapHistory handlers and drop them from the fail-safe.
const USER_EMPTY_OBJECT_TYPES = new Set<string>([]);

function userEmptyFor(type: string): unknown {
  return USER_EMPTY_OBJECT_TYPES.has(type) ? {} : [];
}

infoRouter.post('/', async (c) => {
  const body = await c.req.json();
  const type: string = body.type;
  const user: string | undefined = body.user?.toLowerCase();

  if (!type) {
    return c.json({ error: 'Missing type' }, 400);
  }

  try {
    // Check if we should proxy to real HL
    if (PROXIED_TYPES.has(type)) {
      return cachedProxyToHL(c, body);
    }

    // For user-specific queries, ensure account exists
    if (user) {
      await ensureAccount(user);
    }

    // Handle locally from Redis
    switch (type) {
      case 'allMids': {
        const mids = await redis.hgetall(KEYS.MARKET_MIDS);
        return c.json(mids);
      }

      case 'clearinghouseState': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const state = await getClearinghouseState(user);
        return c.json(state);
      }

      case 'openOrders': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const orders = await getOpenOrders(user);
        return c.json(orders);
      }

      case 'frontendOpenOrders': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const orders = await getFrontendOpenOrders(user);
        return c.json(orders);
      }

      case 'userFills': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const fills = await getUserFills(user);
        return c.json(fills);
      }

      case 'userFillsByTime': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const fills = await getUserFillsByTime(
          user,
          body.startTime ?? 0,
          body.endTime,
        );
        return c.json(fills);
      }

      case 'orderStatus': {
        const status = await getOrderStatus(body.oid);
        return c.json(status);
      }

      case 'historicalOrders': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const rows = await getHistoricalOrdersPg(user, body.limit ?? 200);
        return c.json(rows);
      }

      case 'userFunding': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        return c.json(await getUserFundingPg(user, body.startTime ?? 0, body.endTime));
      }

      case 'userNonFundingLedgerUpdates': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        return c.json(await getLedgerUpdatesPg(user, body.startTime ?? 0, body.endTime));
      }

      case 'portfolio': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        return c.json(await getPortfolio(user));
      }

      case 'userFees': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        return c.json(await getUserFees(user));
      }

      case 'userRateLimit': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        return c.json(await getUserRateLimit(user));
      }

      case 'userRole': {
        // Paper accounts are always plain users (no agents/vaults/sub-accounts).
        return c.json({ role: 'user' });
      }

      case 'activeAssetData': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        if (!body.coin) return c.json({ error: 'Missing coin' }, 400);
        return c.json(await getActiveAssetData(user, body.coin));
      }

      case 'activeAssetCtx': {
        if (!body.coin) return c.json({ error: 'Missing coin' }, 400);
        const ctx = await redis.hgetall(KEYS.MARKET_CTX(body.coin));
        return c.json({ coin: body.coin, ctx });
      }

      default: {
        // Unknown type. Two paths:
        //  - NOT user-scoped (market/reference) → proxy to live HL. Keeps
        //    HyPaper forward-compatible with new market types automatically.
        //  - user-scoped → NEVER proxy (would pollute paper state with real
        //    on-chain data). Passthrough only the explicitly no-paper-
        //    equivalent set; everything else fails safe to a typed empty.
        if (!isUserScoped(body)) {
          return cachedProxyToHL(c, body);
        }
        if (PROXY_ANYWAY_USER_TYPES.has(type)) {
          logger.debug({ type }, 'Proxying no-paper-equivalent user-scoped info type to live HL');
          return cachedProxyToHL(c, body);
        }
        logger.warn({ type, user }, 'Refusing to proxy user-scoped info type in paper mode — returning typed empty (no paper handler yet)');
        return c.json(userEmptyFor(type));
      }
    }
  } catch (err) {
    logger.error({ err, type }, 'Info error');
    return c.json({ error: String(err) }, 500);
  }
});

async function cachedProxyToHL(c: any, body: Record<string, unknown>) {
  const key = getCacheKey(body);
  const now = Date.now();

  const cached = proxyCache.get(key);
  if (cached && cached.expiry > now) {
    return c.json(cached.data);
  }

  const res = await fetch(`${config.HL_API_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  const ttl = PROXY_TTL[body.type as string] ?? DEFAULT_PROXY_TTL;
  proxyCache.set(key, { data, expiry: now + ttl });

  // Evict expired entries periodically (keep map from growing unbounded)
  if (proxyCache.size > 500) {
    for (const [k, v] of proxyCache) {
      if (v.expiry <= now) proxyCache.delete(k);
    }
  }

  return c.json(data);
}
