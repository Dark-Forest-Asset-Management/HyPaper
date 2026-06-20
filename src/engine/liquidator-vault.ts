/**
 * Liquidator vault — HyPaper approximation.
 *
 * On real HL, when a position is backstop-liquidated the Hyperliquid
 * Protocol vault (part of HLP) takes the other side and collects the
 * maintenance margin as a buffer. Proceeds from that vault are later
 * distributed to community participants.
 *
 * HyPaper's approximation:
 *   • The vault IS part of the architecture — it collects liquidation
 *     proceeds so the system is structurally correct.
 *   • Disbursements to users are OUT OF SCOPE for now — no automatic
 *     payouts are made.
 *   • The vault address comes from LIQUIDATOR_VAULT_ADDRESS in .env and
 *     is stored as an env var so it can be rotated without code changes.
 *
 * All vault state lives in Redis (fast, non-critical) and is mirrored
 * into the liquidationEvents PG table via the engine/liquidation.ts path.
 */

import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { add, gt } from '../utils/math.js';
import { creditVaultPg, ensureVaultRowPg } from '../store/pg-queries.js';
import type { LiquidatorVaultState } from '../types/liquidation.js';

// ── Redis key ──────────────────────────────────────────────────────────────

/** Single hash key that holds the vault's running totals. */
const VAULT_KEY = 'liquidator:vault';

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Credit the vault with the proceeds from one liquidation.
 * Called by liquidation.ts after every successful close.
 *
 * @param proceeds - USDC amount to credit (string decimal).
 */
export async function creditVault(proceeds: string): Promise<void> {
  if (!gt(proceeds, '0')) return; // nothing to credit

  const vaultAddress = config.LIQUIDATOR_VAULT_ADDRESS;
  if (!vaultAddress) {
    logger.warn('LIQUIDATOR_VAULT_ADDRESS not set — vault credit skipped');
    return;
  }

  try {
    // Fetch current total, increment, and persist atomically via pipeline.
    const current = await redis.hget(VAULT_KEY, 'totalCollected');
    const newTotal = add(current ?? '0', proceeds);
    const now = Date.now();

    await redis.hset(
      VAULT_KEY,
      'totalCollected', newTotal,
      'vaultAddress', vaultAddress,
      'lastUpdated', now.toString(),
    );

    logger.info(
      { proceeds, newTotal, vaultAddress },
      'Liquidator vault credited',
    );

    // Fire-and-forget durable mirror — don't block the liquidation path on PG.
    creditVaultPg(proceeds).catch((err) =>
      logger.error({ err, proceeds }, 'Failed to mirror vault credit to Postgres'),
    );
  } catch (err) {
    // Non-fatal — the liquidation already completed; vault accounting is
    // best-effort in the approximation.
    logger.error({ err, proceeds }, 'Failed to credit liquidator vault');
  }
}

/**
 * Return the current vault state.
 * Exposed via /hypaper endpoint so the frontend can display vault balance.
 */
export async function getVaultState(): Promise<LiquidatorVaultState> {
  const data = await redis.hgetall(VAULT_KEY);
  return {
    totalCollected: data.totalCollected ?? '0',
    vaultAddress: data.vaultAddress ?? (config.LIQUIDATOR_VAULT_ADDRESS ?? ''),
    lastUpdated: data.lastUpdated ? parseInt(data.lastUpdated, 10) : 0,
  };
}

/**
 * Ensure the vault entry exists in Redis with at least a zero balance.
 * Called once at worker startup.
 */
export async function initVault(): Promise<void> {
  const vaultAddress = config.LIQUIDATOR_VAULT_ADDRESS;
  if (!vaultAddress) {
    logger.warn('LIQUIDATOR_VAULT_ADDRESS not set — liquidator vault will not be initialised');
    return;
  }

  const existing = await redis.hget(VAULT_KEY, 'vaultAddress');
  if (!existing) {
    await redis.hset(
      VAULT_KEY,
      'totalCollected', '0',
      'vaultAddress', vaultAddress,
      'lastUpdated', Date.now().toString(),
    );
    logger.info({ vaultAddress }, 'Liquidator vault initialised');
  }

  // Ensure the durable Postgres mirror row exists too (idempotent).
  try {
    await ensureVaultRowPg(vaultAddress);
  } catch (err) {
    logger.error({ err }, 'Failed to ensure vault row in Postgres');
  }
}

// ── KEYS extension ─────────────────────────────────────────────────────────
// Expose the vault key through KEYS so tests can reference it without
// string literals. We augment via declaration merging at runtime.
// (KEYS is a plain object in store/keys.ts — we add one property here.)
declare module '../store/keys.js' {
  interface KeysType {
    LIQUIDATOR_VAULT: string;
  }
}
(KEYS as Record<string, unknown>).LIQUIDATOR_VAULT = VAULT_KEY;
