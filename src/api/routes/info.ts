import { Hono } from 'hono';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { config } from '../../config.js';
import { getClearinghouseState, getOpenOrders, getFrontendOpenOrders, getOrderStatus } from '../../engine/position.js';
import { getUserFills, getUserFillsByTime } from '../../engine/fill.js';
import { getHistoricalOrdersPg } from '../../store/pg-queries.js';
import { logger } from '../../utils/logger.js';
import { ensureAccount } from '../middleware/auth.js';
import {
  getSubAccounts,
  getVaultDetails,
  getUserVaultEquities,
} from '../../engine/subaccount.js';
import {
  getExtraAgents,
  getMaxBuilderFee,
  getBuilderFeeApproval,
  getReferral,
} from '../../engine/agents.js';
import {
  getDelegations,
  getDelegatorSummary,
  getDelegatorHistory,
  getDelegatorRewards,
} from '../../engine/staking.js';

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

// Endpoints proxied to real HL API
const PROXIED_TYPES = new Set(Object.keys(PROXY_TTL));

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

    switch (type) {

      // ── Market data ──────────────────────────────────────────────────────

      case 'allMids': {
        const mids = await redis.hgetall(KEYS.MARKET_MIDS);
        return c.json(mids);
      }

      case 'activeAssetCtx': {
        if (!body.coin) return c.json({ error: 'Missing coin' }, 400);
        const ctx = await redis.hgetall(KEYS.MARKET_CTX(body.coin));
        return c.json({ coin: body.coin, ctx });
      }

      // ── Clearinghouse / account state ────────────────────────────────────

      case 'clearinghouseState': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const state = await getClearinghouseState(user);
        return c.json(state);
      }

      // ── Spot clearinghouse state ────────────────────────────────

      case 'spotClearinghouseState': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const acctRaw    = await redis.hgetall(KEYS.USER_ACCOUNT(user));
        const usdcBalance = acctRaw.balance ?? '0';

        const perpState  = await getClearinghouseState(user);
        const holdAmount = (perpState as any)?.marginSummary?.totalMarginUsed ?? '0';
        const available  = Math.max(0, parseFloat(usdcBalance) - parseFloat(holdAmount)).toFixed(6);

        return c.json({
          balances: [
            {
              coin:     'USDC',
              token:    0,
              total:    usdcBalance,
              hold:     holdAmount,
              entryNtl: '0.0',
            },
          ],
          tokenToAvailableAfterMaintenance: [[0, available]],
        });
      }

      // ── Orders ───────────────────────────────────────────────────────────

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

      case 'orderStatus': {
        const status = await getOrderStatus(body.oid);
        return c.json(status);
      }

      case 'historicalOrders': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const rows = await getHistoricalOrdersPg(user, body.limit ?? 200);
        return c.json(rows);
      }

      // ── Fills ────────────────────────────────────────────────────────────

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

      // ── Sub-accounts  ────────────────────────────────────────────

      case 'subAccounts': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const subAccounts = await getSubAccounts(user);
        return c.json(subAccounts);
      }

      // ── Vaults  ──────────────────────────────────────────────────

      case 'vaultDetails': {
        if (!body.vaultAddress || typeof body.vaultAddress !== 'string') {
          return c.json({ error: 'Missing vaultAddress' }, 400);
        }
        const details = await getVaultDetails(body.vaultAddress, user);
        return c.json(details);
      }

      case 'userVaultEquities': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const equities = await getUserVaultEquities(user);
        return c.json(equities);
      }

      // ── API Wallets / Agents  ────────────────────────────────────
      //
      // GET /info { type: 'extraAgents', user: '0x...' }
      //
      // Returns the list of approved agent wallets for a master account.
      // Real HL response shape (confirmed from Dwellir docs):
      // [
      //   { "address": "0x...", "name": "AGENT_NAME", "validUntil": null },
      //   ...
      // ]
      // Named agents include their name; unnamed agent has name: "".

      case 'extraAgents': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const agents = await getExtraAgents(user);
        return c.json(agents);
      }

      // ── Builder Fees  ────────────────────────────────────────────
      //
      // GET /info { type: 'maxBuilderFee', user: '0x...', builder: '0x...' }
      //
      // Returns the max fee rate the user approved for a specific builder.
      // Real HL response shape (confirmed from Chainstack docs):
      // { "maxFeeRate": "0.001%" }  — or null if not approved

      case 'maxBuilderFee': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        if (!body.builder || typeof body.builder !== 'string') {
          return c.json({ error: 'Missing builder address' }, 400);
        }
        const result = await getMaxBuilderFee(user, body.builder);
        return c.json(result ?? null);
      }

      // GET /info { type: 'builderFeeApproval', user: '0x...', builder: '0x...' }
      //
      // Returns whether the user has approved this builder and at what rate.
      // Real HL response shape:
      // { "builder": "0x...", "maxFeeRate": "0.001%", "approved": true }
      // — or { "approved": false }

      case 'builderFeeApproval': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        if (!body.builder || typeof body.builder !== 'string') {
          return c.json({ error: 'Missing builder address' }, 400);
        }
        const result = await getBuilderFeeApproval(user, body.builder);
        return c.json(result);
      }

      // ── Referrals  ───────────────────────────────────────────────
      //
      // GET /info { type: 'referral', user: '0x...' }
      //
      // Returns referral state for the user.
      // Real HL response shape:
      // {
      //   "referrerState": {
      //     "data": { "code": "MYCODE", "builderCode": null },
      //     "stage": "percentageReferrer"
      //   },
      //   "referredBy": null,
      //   "cumVlm": "0.0",
      //   "rewardHistory": []
      // }
      // — or referrerState.stage = "noReferrer" if no code set

      case 'referral': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const result = await getReferral(user);
        return c.json(result);
      }

      // ── Staking / Delegation  ────────────────────────────────────
      //
      // GET /info { type: 'delegations', user: '0x...' }
      // Returns active delegations for the user.
      // Real HL response shape:
      // [
      //   { "validator": "0x...", "amount": "100.0",
      //     "lockedUntilTimestamp": 1234567890000, "nSince": 1234567890000 },
      //   ...
      // ]

      case 'delegations': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const result = await getDelegations(user);
        return c.json(result);
      }

      // GET /info { type: 'delegatorSummary', user: '0x...' }
      // Returns a summary of the user's staking state.
      // Real HL response shape:
      // {
      //   "delegated": "100.0",
      //   "undelegated": "50.0",
      //   "totalPendingWithdrawal": "25.0",
      //   "nPendingWithdrawals": 1
      // }

      case 'delegatorSummary': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const result = await getDelegatorSummary(user);
        return c.json(result);
      }

      // GET /info { type: 'delegatorHistory', user: '0x...' }
      // Returns staking event history (most recent first).
      // Real HL response shape:
      // [
      //   { "type": "delegate", "validator": "0x...", "amount": "100.0", "time": 1234567890000 },
      //   { "type": "cDeposit", "validator": null, "amount": "200.0", "time": 1234567890000 },
      //   ...
      // ]

      case 'delegatorHistory': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const result = await getDelegatorHistory(user);
        return c.json(result);
      }

      // GET /info { type: 'delegatorRewards', user: '0x...' }
      // Returns staking rewards. HyPaper returns zeros (no reward simulation).
      // Real HL response shape:
      // { "pendingRewards": "0.0", "totalRewards": "0.0", "rewardHistory": [] }

      case 'delegatorRewards': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const result = await getDelegatorRewards(user);
        return c.json(result);
      }

      // ── Default: proxy to real HL ────────────────────────────────────────

      default: {
        return cachedProxyToHL(c, body);
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

  if (proxyCache.size > 500) {
    for (const [k, v] of proxyCache) {
      if (v.expiry <= now) proxyCache.delete(k);
    }
  }

  return c.json(data);
}