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
  // Sub-accounts start EMPTY — live-HL parity: a freshly created sub has
  // $0 everywhere and is funded exclusively via subAccountTransfer from
  // the master. The faucet below is for new USER wallets only. The
  // reverse pointer is written by createSubAccount BEFORE it calls
  // ensureAccount, so it's always visible here.
  const isSub = !exists && !!(await redis.get(KEYS.SUBACCOUNT_MASTER(wallet)));
  if (!exists) {
    // Live-parity seeding: new USER wallets get DEFAULT_BALANCE on the HL
    // perp balance ONLY. Spot and every sub-dex start at $0 — reaching
    // them takes a usdClassTransfer / sendAsset, exactly like live
    // operations. Sub-accounts get $0 everywhere.
    const seed = isSub ? '0' : config.DEFAULT_BALANCE.toString();
    await redis.hset(KEYS.USER_ACCOUNT(wallet),
      'userId', wallet,
      'balance', seed,
      KEYS.USER_BAL_SPOT_FIELD, '0',
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
  if (!exists && !isSub) {
    recordLedgerUpdate(wallet, {
      time: Date.now(),
      deltaType: 'deposit',
      usdc: config.DEFAULT_BALANCE.toString(),
    });
  }

  // ── Sub-dex balance-field initialization ────────────────────────────────
  // HL semantics: each builder-deployed sub-dex (xyz, flx, …) is its own
  // subaccount with independent equity, funded from native via an explicit
  // transfer. Full live parity (2026-08-15): every sub-dex field starts at
  // $0 — the earlier trade-UX-over-parity DEFAULT_BALANCE seeding is gone,
  // so placing xyz: orders requires funding the dex first, same as live.
  //
  // Idempotent: per-dex marker field `seeded:${dex}` blocks re-initializing
  // after the field exists (a later balance would otherwise be clobbered).
  try {
    const perpDexsRaw = await redis.get(KEYS.MARKET_PERPDEXS);
    if (!perpDexsRaw) return;
    const perpDexs: Array<{ name?: string } | null> = JSON.parse(perpDexsRaw);
    for (const d of perpDexs) {
      if (!d?.name) continue;
      const seededField = `seeded:${d.name}`;
      const wasSeeded = await redis.hget(KEYS.USER_ACCOUNT(wallet), seededField);
      if (wasSeeded === '1') continue;
      // Live parity: EVERY account (user or sub) starts a sub-dex at $0 —
      // funding a builder dex takes an explicit transfer from native, same
      // as live. The seeded marker still gets written so nothing re-seeds.
      await redis.hset(KEYS.USER_ACCOUNT(wallet),
        KEYS.USER_BAL_FIELD(d.name), '0',
        seededField, '1',
      );
    }
  } catch { /* sub-dex seeding is best-effort — never block account creation */ }
}
