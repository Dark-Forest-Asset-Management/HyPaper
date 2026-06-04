import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { config } from '../../config.js';
import { upsertUser, recordLedgerUpdate } from '../../store/pg-sink.js';

/**
 * Ensure a wallet address has an account in Redis and Postgres.
 * Auto-creates in Redis with default balance on first touch, and ALWAYS
 * upserts into Postgres so we recover from prior write failures
 * (e.g. when the schema didn't exist yet on first request, or a
 * Postgres outage caused queued writes to be dropped).
 */
export async function ensureAccount(wallet: string): Promise<void> {
  const exists = await redis.exists(KEYS.USER_ACCOUNT(wallet));
  if (!exists) {
    await redis.hset(KEYS.USER_ACCOUNT(wallet),
      'userId', wallet,
      'balance', config.DEFAULT_BALANCE.toString(),
      // Spot USDC is its own bucket — seed equal to perp so a new wallet can
      // trade either side without first doing a usdClassTransfer. The two
      // books then diverge from here as the wallet trades and transfers.
      KEYS.USER_BAL_SPOT_FIELD, config.DEFAULT_BALANCE.toString(),
      'createdAt', Date.now().toString(),
    );
  }

  // Idempotent upsert (INSERT ON CONFLICT DO UPDATE in pg-sink) — runs every
  // request. Reconciles with whatever balance Redis currently holds so we
  // don't clobber post-trade state with the default.
  const balance = (await redis.hget(KEYS.USER_ACCOUNT(wallet), 'balance'))
    ?? config.DEFAULT_BALANCE.toString();
  upsertUser(wallet, balance);

  // First-touch funding shows up as a deposit in /info
  // userNonFundingLedgerUpdates. Enqueued AFTER upsertUser so the users-row
  // FK is satisfied (the write queue is FIFO).
  if (!exists) {
    recordLedgerUpdate(wallet, {
      time: Date.now(),
      deltaType: 'deposit',
      usdc: config.DEFAULT_BALANCE.toString(),
    });
  }

  // ── Sub-dex subaccount seeding ──────────────────────────────────────────
  // HL semantics: each builder-deployed sub-dex (xyz, flx, …) is its own
  // subaccount with independent equity. Live HL requires the user to call
  // perpDexClassTransfer to fund the sub-dex from native. In paper we trade
  // UX over strict parity here: on first touch, seed each known sub-dex
  // with DEFAULT_BALANCE so the user can place xyz: brackets immediately
  // without a separate transfer step.
  //
  // Idempotent: per-dex marker field `seeded:${dex}` blocks re-seeding after
  // the first balance has been spent.
  try {
    const perpDexsRaw = await redis.get(KEYS.MARKET_PERPDEXS);
    if (!perpDexsRaw) return;
    const perpDexs: Array<{ name?: string } | null> = JSON.parse(perpDexsRaw);
    for (const d of perpDexs) {
      if (!d?.name) continue;
      const seededField = `seeded:${d.name}`;
      const wasSeeded = await redis.hget(KEYS.USER_ACCOUNT(wallet), seededField);
      if (wasSeeded === '1') continue;
      await redis.hset(KEYS.USER_ACCOUNT(wallet),
        KEYS.USER_BAL_FIELD(d.name), config.DEFAULT_BALANCE.toString(),
        seededField, '1',
      );
    }
  } catch { /* sub-dex seeding is best-effort — never block account creation */ }
}
