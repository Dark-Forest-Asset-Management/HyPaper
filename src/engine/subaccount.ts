/**
 * src/engine/subaccount.ts
 *
 * Engine functions for sub-account and vault operations.
 *
 * Sub-accounts
 * ─────────────
 * HL sub-accounts are separate wallets under a master account. They do NOT
 * have their own private keys — the master signs on their behalf using the
 * `vaultAddress` field. In HyPaper we simulate sub-accounts by:
 *   - Storing metadata (name, master, createdAt) in Redis
 *   - Giving each sub-account its own paper trading account (same ensureAccount
 *     path as a normal user) so it has its own positions/orders/fills
 *   - Recording the master → sub reverse link so /info subAccounts can list them
 *
 * Sub-account transfers (subAccountTransfer / subAccountSpotTransfer)
 * debit/credit the perp USDC balance between master and sub-account.
 * Spot token transfers are acknowledged only (HyPaper has no spot balance
 * simulation beyond USDC).
 *
 * Vaults
 * ───────
 * Vaults in HL are complex (managed trading pools with their own PnL, fee
 * splits, followers). HyPaper doesn't simulate vault trading, but it does:
 *   - Accept vaultTransfer without hard-rejecting unknown vault addresses
 *   - Track how much each user has deposited per vault address
 *   - Serve /info vaultDetails and userVaultEquities with the stored data
 */

import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import { ensureAccount } from '../api/middleware/auth.js';

// ─── Sub-account helpers ──────────────────────────────────────────────────────

/**
 * Returns true if `subAddr` is a known sub-account of `masterUserId`.
 */
export async function isSubAccountOf(
  masterUserId: string,
  subAddr: string,
): Promise<boolean> {
  const masterRaw = await redis.get(KEYS.SUBACCOUNT_MASTER(subAddr));
  return masterRaw?.toLowerCase() === masterUserId.toLowerCase();
}

// ─── createSubAccount ─────────────────────────────────────────────────────────
//
// Creates a new paper sub-account under the given master wallet.
// HL enforces that sub-account names must be unique per master.
//
// On success:
//   - The sub-account address is deterministically derived from the master
//     address + name so that the same call always produces the same address.
//     We use a simple hash approach consistent with HyPaper's paper-trading
//     nature (real HL derives addresses on-chain).
//   - A paper trading account is initialised for the sub-account address.
//   - Metadata is written to Redis.
//
// HL response: { type: 'default' } on success (confirmed from probe captures).

export async function createSubAccount(
  masterUserId: string,
  name: string,
): Promise<{ subAccountUser: string } | { error: string }> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: 'Sub-account name cannot be empty' };
  if (trimmedName.length > 32) return { error: 'Sub-account name too long (max 32 chars)' };

  // Check duplicate name under this master
  const existingRaw = await redis.zrange(KEYS.USER_SUBACCOUNTS(masterUserId), 0, -1);
  for (const subAddr of existingRaw) {
    const meta = await redis.hgetall(KEYS.SUBACCOUNT_META(subAddr));
    if (meta.name?.toLowerCase() === trimmedName.toLowerCase()) {
      return { error: `Sub-account name '${trimmedName}' already exists` };
    }
  }

  // Derive a deterministic paper sub-account address.
  // We encode master + name into a hex string padded to 40 chars (20 bytes).
  // This is a paper simulation — real HL derives addresses on-chain.
  const raw = `${masterUserId}:${trimmedName}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  // Produce a deterministic 20-byte address from the hash
  const hashHex = Math.abs(hash).toString(16).padStart(8, '0');
  const masterHex = masterUserId.replace(/^0x/i, '').slice(0, 32);
  const subAccountUser = `0x${masterHex}${hashHex}`.slice(0, 42).padEnd(42, '0');

  const now = Date.now();

  const pipeline = redis.pipeline();
  // Register sub-account under master (sorted by creation time)
  pipeline.zadd(KEYS.USER_SUBACCOUNTS(masterUserId), now, subAccountUser);
  // Store metadata on the sub-account key
  pipeline.hset(KEYS.SUBACCOUNT_META(subAccountUser), {
    name: trimmedName,
    master: masterUserId,
    subAccountUser,
    createdAt: now.toString(),
  });
  // Reverse pointer: sub-account → master
  pipeline.set(KEYS.SUBACCOUNT_MASTER(subAccountUser), masterUserId);
  await pipeline.exec();

  // Initialise a paper trading account for this sub-account address
  // so it can hold positions, orders, fills just like a normal user.
  await ensureAccount(subAccountUser);

  logger.info({ masterUserId, subAccountUser, name: trimmedName }, 'Sub-account created');
  return { subAccountUser };
}

// ─── subAccountTransfer ───────────────────────────────────────────────────────
//
// Transfers USDC (perp balance) between the master account and a sub-account.
// `isDeposit: true` = master → sub-account.
// `isDeposit: false` = sub-account → master.
// `usd` is in 1e-6 units (same as updateIsolatedMargin's `ntli`).
//
// HyPaper tracks perp USDC as the `accountValue` in the clearinghouse state.
// The balance is stored in the user account hash under key `balance`.

export async function subAccountTransfer(
  masterUserId: string,
  subAccountUser: string,
  isDeposit: boolean,
  usd: number,
): Promise<{ ok: true } | { error: string }> {
  const subAddr = subAccountUser.toLowerCase();

  // Verify this sub-account belongs to this master
  const masterRaw = await redis.get(KEYS.SUBACCOUNT_MASTER(subAddr));
  if (!masterRaw || masterRaw.toLowerCase() !== masterUserId.toLowerCase()) {
    return { error: `Sub-account ${subAccountUser} not found or does not belong to this account` };
  }

  // Convert from 1e-6 units to dollar amount
  const amountUsd = usd / 1_000_000;
  if (amountUsd <= 0) return { error: 'Transfer amount must be positive' };

  const senderKey   = isDeposit ? KEYS.USER_ACCOUNT(masterUserId) : KEYS.USER_ACCOUNT(subAddr);
  const receiverKey = isDeposit ? KEYS.USER_ACCOUNT(subAddr)       : KEYS.USER_ACCOUNT(masterUserId);

  const senderRaw = await redis.hgetall(senderKey);
  const senderBalance = parseFloat(senderRaw.balance ?? '0');

  if (senderBalance < amountUsd) {
    return { error: `Insufficient balance: have ${senderBalance.toFixed(6)}, need ${amountUsd.toFixed(6)}` };
  }

  const newSenderBalance   = (senderBalance - amountUsd).toFixed(6);
  const receiverRaw        = await redis.hgetall(receiverKey);
  const receiverBalance    = parseFloat(receiverRaw.balance ?? '0');
  const newReceiverBalance = (receiverBalance + amountUsd).toFixed(6);

  const pipeline = redis.pipeline();
  pipeline.hset(senderKey,   'balance', newSenderBalance);
  pipeline.hset(receiverKey, 'balance', newReceiverBalance);
  await pipeline.exec();

  logger.info(
    { masterUserId, subAddr, isDeposit, amountUsd },
    'subAccountTransfer executed',
  );
  return { ok: true };
}

// ─── subAccountSpotTransfer ───────────────────────────────────────────────────
//
// Transfers a spot token between master and sub-account.
// HyPaper has no spot balance simulation for arbitrary tokens, so we
// acknowledge the action (same as real HL returns { type: 'default' })
// without touching any Redis state. This prevents the frontend from breaking
// when it sends this action in paper mode.

export async function subAccountSpotTransfer(
  masterUserId: string,
  subAccountUser: string,
  isDeposit: boolean,
  token: string,
  amount: string,
): Promise<{ ok: true } | { error: string }> {
  const subAddr = subAccountUser.toLowerCase();

  // Still validate that the sub-account belongs to this master
  const masterRaw = await redis.get(KEYS.SUBACCOUNT_MASTER(subAddr));
  if (!masterRaw || masterRaw.toLowerCase() !== masterUserId.toLowerCase()) {
    return { error: `Sub-account ${subAccountUser} not found or does not belong to this account` };
  }

  // Spot token transfers are acknowledged-only in HyPaper.
  // Real HL moves actual HIP-1/2 tokens; we just log it.
  logger.info(
    { masterUserId, subAddr, isDeposit, token, amount },
    'subAccountSpotTransfer acknowledged (spot balance not simulated)',
  );
  return { ok: true };
}

// ─── vaultTransfer ────────────────────────────────────────────────────────────
//
// Deposits into or withdraws from a vault.
// HyPaper doesn't simulate vault trading (PnL, positions, profit sharing).
// What we DO simulate:
//   - Track user's equity per vault address (so userVaultEquities works)
//   - Track minimal vault metadata so vaultDetails works
//   - Accept any vault address (remove the previous hard-reject)
//
// `usd` is in 1e-6 units (integer, same as ntli).

export async function vaultTransfer(
  userId: string,
  vaultAddress: string,
  isDeposit: boolean,
  usd: number,
): Promise<{ ok: true } | { error: string }> {
  const vaultAddr = vaultAddress.toLowerCase();
  const amountUsd = usd / 1_000_000;

  if (amountUsd <= 0) return { error: 'Transfer amount must be positive' };

  const userAccountKey = KEYS.USER_ACCOUNT(userId);
  const userRaw = await redis.hgetall(userAccountKey);
  const userBalance = parseFloat(userRaw.balance ?? '0');

  if (isDeposit) {
    // Deposit: debit the user's perp balance, credit their vault equity
    if (userBalance < amountUsd) {
      return { error: `Insufficient balance: have ${userBalance.toFixed(6)}, need ${amountUsd.toFixed(6)}` };
    }

    const currentEquityRaw = await redis.hget(KEYS.USER_VAULT_EQUITIES(userId), vaultAddr);
    const currentEquity = parseFloat(currentEquityRaw ?? '0');
    const newEquity = (currentEquity + amountUsd).toFixed(6);
    const newBalance = (userBalance - amountUsd).toFixed(6);

    const pipeline = redis.pipeline();
    pipeline.hset(userAccountKey, 'balance', newBalance);
    pipeline.hset(KEYS.USER_VAULT_EQUITIES(userId), vaultAddr, newEquity);
    // Ensure minimal vault metadata exists for /info vaultDetails
    const existingMeta = await redis.hgetall(KEYS.VAULT_META(vaultAddr));
    if (!existingMeta.vaultAddress) {
      pipeline.hset(KEYS.VAULT_META(vaultAddr), {
        vaultAddress: vaultAddr,
        name: 'Paper Vault',
        leader: userId,
        description: 'HyPaper simulated vault',
        isClosed: 'false',
        createdAt: Date.now().toString(),
      });
    }
    await pipeline.exec();

    logger.info({ userId, vaultAddr, amountUsd }, 'vaultTransfer deposit executed');
  } else {
    // Withdraw: credit the user's perp balance, debit their vault equity
    const currentEquityRaw = await redis.hget(KEYS.USER_VAULT_EQUITIES(userId), vaultAddr);
    const currentEquity = parseFloat(currentEquityRaw ?? '0');

    if (currentEquity < amountUsd) {
      return { error: `Insufficient vault equity: have ${currentEquity.toFixed(6)}, need ${amountUsd.toFixed(6)}` };
    }

    const newEquity  = (currentEquity - amountUsd).toFixed(6);
    const newBalance = (userBalance   + amountUsd).toFixed(6);

    const pipeline = redis.pipeline();
    pipeline.hset(userAccountKey, 'balance', newBalance);
    pipeline.hset(KEYS.USER_VAULT_EQUITIES(userId), vaultAddr, newEquity);
    await pipeline.exec();

    logger.info({ userId, vaultAddr, amountUsd }, 'vaultTransfer withdrawal executed');
  }

  return { ok: true };
}

// ─── Info query functions ─────────────────────────────────────────────────────

/**
 * Returns the list of sub-accounts for a master user.
 * Shape matches real HL /info subAccounts response.
 */
export async function getSubAccounts(masterUserId: string): Promise<unknown[]> {
  const subAddrs = await redis.zrange(KEYS.USER_SUBACCOUNTS(masterUserId), 0, -1);
  if (subAddrs.length === 0) return [];

  const results = [];
  for (const subAddr of subAddrs) {
    const meta = await redis.hgetall(KEYS.SUBACCOUNT_META(subAddr));
    if (!meta.name) continue; // stale key, skip

    // Build a minimal clearinghouse state for this sub-account.
    // We import getClearinghouseState lazily to avoid circular imports.
    const { getClearinghouseState } = await import('./position.js');
    const clearinghouseState = await getClearinghouseState(subAddr);

    // Build a minimal spot state (HyPaper only tracks USDC).
    const acctRaw = await redis.hgetall(KEYS.USER_ACCOUNT(subAddr));
    const usdcBalance = acctRaw.balance ?? '0';

    results.push({
      name: meta.name,
      subAccountUser: subAddr,
      master: meta.master,
      clearinghouseState,
      spotState: {
        balances: [
          {
            coin: 'USDC',
            token: 0,
            total: usdcBalance,
            hold: '0.0',
            entryNtl: '0.0',
          },
        ],
      },
    });
  }

  return results;
}

/**
 * Returns vault details for a given vault address.
 * Shape matches real HL /info vaultDetails response.
 * HyPaper returns minimal data since no vault trading is simulated.
 */
export async function getVaultDetails(
  vaultAddress: string,
  userAddress?: string,
): Promise<unknown> {
  const vaultAddr = vaultAddress.toLowerCase();
  const meta = await redis.hgetall(KEYS.VAULT_META(vaultAddr));

  // Build follower list from users who have equity in this vault
  // We scan for USER_VAULT_EQUITIES keys — this is acceptable at paper-trading scale.
  let cursor = '0';
  const followerKeys: string[] = [];
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH', 'user:*:vault_equities',
      'COUNT', 100,
    );
    cursor = nextCursor;
    followerKeys.push(...keys);
  } while (cursor !== '0');

  const followers = [];
  for (const key of followerKeys) {
    const equityStr = await redis.hget(key, vaultAddr);
    if (!equityStr || parseFloat(equityStr) <= 0) continue;
    // Extract userId from key pattern: user:{userId}:vault_equities
    const parts = key.split(':');
    if (parts.length < 3) continue;
    const followerUser = parts[1];
    followers.push({
      user: followerUser,
      vaultEquity: equityStr,
      pnl: '0.0',
      allTimePnl: '0.0',
      daysFollowing: 0,
      vaultEntryTime: parseInt(meta.createdAt ?? '0', 10),
      lockupUntil: 0,
    });
  }

  // followerState for the querying user
  let followerState = null;
  if (userAddress) {
    const equityStr = await redis.hget(KEYS.USER_VAULT_EQUITIES(userAddress.toLowerCase()), vaultAddr);
    if (equityStr && parseFloat(equityStr) > 0) {
      followerState = {
        equity: equityStr,
        pnl: '0.0',
        allTimePnl: '0.0',
      };
    }
  }

  return {
    name: meta.name ?? 'Unknown Vault',
    vaultAddress: vaultAddr,
    leader: meta.leader ?? vaultAddr,
    description: meta.description ?? '',
    portfolio: [],
    apr: 0,
    followerState,
    leaderFraction: 0,
    leaderCommission: 0,
    followers,
    maxDistributable: 0,
    maxWithdrawable: 0,
    isClosed: meta.isClosed === 'true',
    relationship: { type: 'unrelated' },
    allowDeposits: true,
    alwaysCloseOnWithdraw: false,
  };
}

/**
 * Returns all vault equities for a user.
 * Shape matches real HL /info userVaultEquities response.
 */
export async function getUserVaultEquities(userId: string): Promise<unknown[]> {
  const equities: Record<string, string> = await redis.hgetall(KEYS.USER_VAULT_EQUITIES(userId));
  if (!equities || Object.keys(equities).length === 0) return [];

  return (Object.entries(equities) as [string, string][])
    .filter(([, equity]) => parseFloat(equity) > 0)
    .map(([vaultAddress, equity]) => ({ vaultAddress, equity }));
}