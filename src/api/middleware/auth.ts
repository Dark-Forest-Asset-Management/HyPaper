import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { config } from '../../config.js';
import { upsertUser } from '../../store/pg-sink.js';

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
      'createdAt', Date.now().toString(),
    );
  }

  // Idempotent upsert (INSERT ON CONFLICT DO UPDATE in pg-sink) — runs every
  // request. Reconciles with whatever balance Redis currently holds so we
  // don't clobber post-trade state with the default.
  const balance = (await redis.hget(KEYS.USER_ACCOUNT(wallet), 'balance'))
    ?? config.DEFAULT_BALANCE.toString();
  upsertUser(wallet, balance);
}
