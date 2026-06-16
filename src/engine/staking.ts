/**
 * src/engine/staking.ts
 *
 * Engine functions — Staking / Delegation:
 *   cDeposit      — move HYPE from spot balance into staking account
 *   cWithdraw     — initiate 7-day unstake queue (withdraw from staking)
 *   tokenDelegate — delegate/undelegate staked HYPE to a validator (1-day lockup)
 *
 * ── STAKING MODEL ─────────────────────────────────────────────────────────────
 * Real HL staking flow:
 *   spot balance → cDeposit → staking balance → tokenDelegate → validator
 *
 * HyPaper paper simulation:
 *   - USER_STAKING_BALANCE(userId)  — HYPE available in staking account (not yet delegated)
 *   - USER_DELEGATIONS(userId)      — sorted set: score=unlockTimestamp member=JSON
 *   - USER_STAKING_QUEUE(userId)    — sorted set: score=unlockTimestamp(7d) member=JSON
 *   - STAKING_EVENTS(userId)        — list: log of all staking events for history
 *
 * HYPE amounts use the same unit as real HL: wei (1 HYPE = 1e8 wei).
 * All amounts stored in Redis as wei strings.
 *
 * ── 7-DAY UNSTAKE QUEUE ───────────────────────────────────────────────────────
 * cWithdraw moves HYPE from staking balance into a queue. It becomes available
 * again (back in spot) after 7 days. A background worker (StakingWorker) sweeps
 * the queue every 60 seconds and completes withdrawals when their unlock time passes.
 *
 * ── 1-DAY DELEGATION LOCKUP ───────────────────────────────────────────────────
 * tokenDelegate stores the delegation with a lockup timestamp = now + 1 day.
 * Undelegating before the lockup returns an error.
 * After the lockup, undelegating moves HYPE back to staking balance.
 */

import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS    = 1 * 24 * 60 * 60 * 1000;

// ─── cDeposit ─────────────────────────────────────────────────────────────────
// Moves HYPE from user's spot balance into their staking account.
// `wei` is the amount in HL wei units (1 HYPE = 1e8 wei).
//
// In HyPaper: spot balance (USER_ACCOUNT "balance") is USDC-denominated.
// HYPE is a separate token. We track HYPE in USER_STAKING_BALANCE as a
// separate bucket — paper users start with 0 HYPE and can deposit any
// amount they specify (no HYPE spot balance enforcement in paper mode).
//
// Real HL success response: { status: "ok", response: { type: "default" } }

export async function cDeposit(
  userId: string,
  wei:    number,
): Promise<{ ok: true } | { error: string }> {
  if (!Number.isFinite(wei) || wei <= 0) {
    return { error: 'wei must be a positive integer' };
  }
  if (!Number.isInteger(wei)) {
    return { error: 'wei must be an integer (1 HYPE = 100000000 wei)' };
  }

  const currentRaw = await redis.get(KEYS.USER_STAKING_BALANCE(userId));
  const current    = BigInt(currentRaw ?? '0');
  const updated    = current + BigInt(wei);

  await redis.set(KEYS.USER_STAKING_BALANCE(userId), updated.toString());

  // Log staking event for delegatorHistory
  await appendStakingEvent(userId, {
    type:      'cDeposit',
    wei:       wei.toString(),
    timestamp: Date.now(),
  });

  logger.info({ userId, wei }, 'cDeposit — HYPE moved to staking account');
  return { ok: true };
}

// ─── cWithdraw ────────────────────────────────────────────────────────────────
// Initiates a 7-day unstake queue.
// HYPE is deducted from staking balance immediately and placed in the queue.
// After 7 days the StakingWorker completes the withdrawal (moves back to spot).
//
// Real HL success response: { status: "ok", response: { type: "default" } }

export async function cWithdraw(
  userId: string,
  wei:    number,
): Promise<{ ok: true } | { error: string }> {
  if (!Number.isFinite(wei) || wei <= 0) {
    return { error: 'wei must be a positive integer' };
  }
  if (!Number.isInteger(wei)) {
    return { error: 'wei must be an integer (1 HYPE = 100000000 wei)' };
  }

  const currentRaw = await redis.get(KEYS.USER_STAKING_BALANCE(userId));
  const current    = BigInt(currentRaw ?? '0');

  if (current < BigInt(wei)) {
    return {
      error: `Insufficient staking balance: have ${current} wei, need ${wei} wei`,
    };
  }

  const updated    = current - BigInt(wei);
  const unlockTime = Date.now() + SEVEN_DAYS_MS;

  const queueEntry = JSON.stringify({
    wei:        wei.toString(),
    unlockTime,
    queuedAt:   Date.now(),
  });

  const pipeline = redis.pipeline();
  pipeline.set(KEYS.USER_STAKING_BALANCE(userId), updated.toString());
  // Add to 7-day queue: score = unlockTime (unix ms), member = JSON entry
  pipeline.zadd(KEYS.USER_STAKING_QUEUE(userId), unlockTime, queueEntry);
  await pipeline.exec();

  // Log staking event
  await appendStakingEvent(userId, {
    type:       'cWithdraw',
    wei:        wei.toString(),
    unlockTime,
    timestamp:  Date.now(),
  });

  logger.info({ userId, wei, unlockTime }, 'cWithdraw — HYPE queued for 7-day unstake');
  return { ok: true };
}

// ─── tokenDelegate ────────────────────────────────────────────────────────────
// Delegate or undelegate staked HYPE to/from a validator.
// isUndelegate: false = delegate, true = undelegate
//
// Delegate:
//   - Deducts wei from staking balance
//   - Creates delegation record with 1-day lockup
//   - Undelegating before lockup expires returns an error
//
// Undelegate:
//   - Checks lockup hasn't expired... wait, lockup is minimum hold period.
//     After 1 day you CAN undelegate. Before 1 day you CANNOT.
//   - Returns HYPE to staking balance immediately on undelegation.
//
// Real HL success response: { status: "ok", response: { type: "default" } }

export async function tokenDelegate(
  userId:       string,
  validator:    string,
  wei:          number,
  isUndelegate: boolean,
): Promise<{ ok: true } | { error: string }> {
  if (!Number.isFinite(wei) || wei <= 0) {
    return { error: 'wei must be a positive integer' };
  }
  if (!Number.isInteger(wei)) {
    return { error: 'wei must be an integer (1 HYPE = 100000000 wei)' };
  }
  if (!validator || typeof validator !== 'string') {
    return { error: 'validator address is required' };
  }

  const validatorAddr = validator.toLowerCase();
  const delegKey      = KEYS.USER_DELEGATIONS(userId);

  if (!isUndelegate) {
    // ── Delegate ──────────────────────────────────────────────────────────────
    // Check staking balance
    const stakingRaw = await redis.get(KEYS.USER_STAKING_BALANCE(userId));
    const staking    = BigInt(stakingRaw ?? '0');

    if (staking < BigInt(wei)) {
      return {
        error: `Insufficient staking balance: have ${staking} wei, need ${wei} wei`,
      };
    }

    const lockedUntil  = Date.now() + ONE_DAY_MS;
    const delegation   = JSON.stringify({
      validator:   validatorAddr,
      wei:         wei.toString(),
      lockedUntil,
      delegatedAt: Date.now(),
    });

    const pipeline = redis.pipeline();
    pipeline.set(KEYS.USER_STAKING_BALANCE(userId), (staking - BigInt(wei)).toString());
    // Store delegation: score = lockedUntil, member = JSON
    pipeline.zadd(delegKey, lockedUntil, delegation);
    await pipeline.exec();

    await appendStakingEvent(userId, {
      type:      'delegate',
      validator: validatorAddr,
      wei:       wei.toString(),
      lockedUntil,
      timestamp: Date.now(),
    });

    logger.info({ userId, validatorAddr, wei, lockedUntil }, 'tokenDelegate — delegated');
    return { ok: true };

  } else {
    // ── Undelegate ────────────────────────────────────────────────────────────
    // Find a delegation to this validator with enough wei
    const allEntries = await redis.zrange(delegKey, 0, -1, 'WITHSCORES') as string[];

    // zrange WITHSCORES returns [member, score, member, score, ...]
    type DelegEntry = { raw: string; score: number; parsed: {
      validator: string; wei: string; lockedUntil: number; delegatedAt: number;
    }};
    const entries: DelegEntry[] = [];
    for (let i = 0; i < allEntries.length; i += 2) {
      try {
        const parsed = JSON.parse(allEntries[i]);
        if (parsed.validator === validatorAddr) {
          entries.push({
            raw:    allEntries[i],
            score:  parseFloat(allEntries[i + 1]),
            parsed,
          });
        }
      } catch { /* skip malformed entries */ }
    }

    if (entries.length === 0) {
      return { error: `No delegation found for validator ${validator}` };
    }

    // Find first matching delegation with enough wei
    const match = entries.find(e => BigInt(e.parsed.wei) >= BigInt(wei));
    if (!match) {
      return {
        error: `Insufficient delegation to validator ${validator}: ` +
               `total delegated ${entries.reduce((s, e) => s + BigInt(e.parsed.wei), 0n)} wei, need ${wei} wei`,
      };
    }

    // Check 1-day lockup
    const now = Date.now();
    if (now < match.parsed.lockedUntil) {
      const remainingMs  = match.parsed.lockedUntil - now;
      const remainingMin = Math.ceil(remainingMs / 60_000);
      return {
        error: `Delegation is locked for ${remainingMin} more minutes (1-day lockup). ` +
               `Unlock at: ${new Date(match.parsed.lockedUntil).toISOString()}`,
      };
    }

    // Remove the old delegation entry
    const pipeline = redis.pipeline();
    pipeline.zrem(delegKey, match.raw);

    // If partial undelegate: re-add remainder
    const remaining = BigInt(match.parsed.wei) - BigInt(wei);
    if (remaining > 0n) {
      const newEntry = JSON.stringify({
        validator:   validatorAddr,
        wei:         remaining.toString(),
        lockedUntil: match.parsed.lockedUntil,
        delegatedAt: match.parsed.delegatedAt,
      });
      pipeline.zadd(delegKey, match.parsed.lockedUntil, newEntry);
    }

    // Return HYPE to staking balance
    const stakingRaw = await redis.get(KEYS.USER_STAKING_BALANCE(userId));
    const staking    = BigInt(stakingRaw ?? '0');
    pipeline.set(KEYS.USER_STAKING_BALANCE(userId), (staking + BigInt(wei)).toString());

    await pipeline.exec();

    await appendStakingEvent(userId, {
      type:      'undelegate',
      validator: validatorAddr,
      wei:       wei.toString(),
      timestamp: Date.now(),
    });

    logger.info({ userId, validatorAddr, wei }, 'tokenDelegate — undelegated');
    return { ok: true };
  }
}

// ─── Info query functions ─────────────────────────────────────────────────────

/**
 * Returns active delegations for a user.
 * Real HL /info delegations response shape:
 * [
 *   {
 *     "validator": "0x...",
 *     "amount": "100.0",        (HYPE, not wei)
 *     "lockedUntilTimestamp": 1234567890000,
 *     "nSince": 1234567890000
 *   },
 *   ...
 * ]
 */
export async function getDelegations(userId: string): Promise<unknown[]> {
  const delegKey = KEYS.USER_DELEGATIONS(userId);
  const entries  = await redis.zrange(delegKey, 0, -1) as string[];

  if (!entries.length) return [];

  return entries.map(raw => {
    try {
      const d = JSON.parse(raw);
      // Convert wei to HYPE (1 HYPE = 1e8 wei) for display
      const weiToHype = (w: string) => {
        const big      = BigInt(w);
        const whole    = big / BigInt(1e8);
        const fraction = big % BigInt(1e8);
        const fracStr  = fraction.toString().padStart(8, '0').replace(/0+$/, '');
        return fracStr ? `${whole}.${fracStr}` : `${whole}.0`;
      };
      return {
        validator:            d.validator,
        amount:               weiToHype(d.wei),
        lockedUntilTimestamp: d.lockedUntil,
        nSince:               d.delegatedAt,
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Returns staking summary for a user.
 * Real HL /info delegatorSummary response shape:
 * {
 *   "delegated": "100.0",
 *   "undelegated": "50.0",
 *   "totalPendingWithdrawal": "25.0",
 *   "nPendingWithdrawals": 1
 * }
 */
export async function getDelegatorSummary(userId: string): Promise<unknown> {
  // Staking balance (available, not yet delegated)
  const stakingRaw = await redis.get(KEYS.USER_STAKING_BALANCE(userId));
  const undelegated = BigInt(stakingRaw ?? '0');

  // Sum all active delegations
  const delegEntries = await redis.zrange(KEYS.USER_DELEGATIONS(userId), 0, -1) as string[];
  let delegated = 0n;
  for (const raw of delegEntries) {
    try { delegated += BigInt(JSON.parse(raw).wei); } catch { /* skip */ }
  }

  // Sum all pending withdrawals (7-day queue)
  const queueEntries = await redis.zrange(KEYS.USER_STAKING_QUEUE(userId), 0, -1) as string[];
  let pendingWei = 0n;
  for (const raw of queueEntries) {
    try { pendingWei += BigInt(JSON.parse(raw).wei); } catch { /* skip */ }
  }

  const weiToHype = (w: bigint) => {
    const whole    = w / BigInt(1e8);
    const fraction = w % BigInt(1e8);
    const fracStr  = fraction.toString().padStart(8, '0').replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : `${whole}.0`;
  };

  return {
    delegated:              weiToHype(delegated),
    undelegated:            weiToHype(undelegated),
    totalPendingWithdrawal: weiToHype(pendingWei),
    nPendingWithdrawals:    queueEntries.length,
  };
}

/**
 * Returns staking history for a user.
 * Real HL /info delegatorHistory response shape:
 * [
 *   { "type": "delegate", "validator": "0x...", "amount": "100.0", "time": 1234567890000 },
 *   { "type": "undelegate", "validator": "0x...", "amount": "50.0", "time": 1234567890000 },
 *   { "type": "cDeposit", "amount": "200.0", "time": 1234567890000 },
 *   { "type": "cWithdraw", "amount": "25.0", "time": 1234567890000 },
 *   ...
 * ]
 */
export async function getDelegatorHistory(userId: string): Promise<unknown[]> {
  const raw = await redis.lrange(KEYS.STAKING_EVENTS(userId), 0, -1) as string[];
  if (!raw.length) return [];

  return raw.map(entry => {
    try {
      const e = JSON.parse(entry);
      const weiToHype = (w: string) => {
        const big      = BigInt(w);
        const whole    = big / BigInt(1e8);
        const fraction = big % BigInt(1e8);
        const fracStr  = fraction.toString().padStart(8, '0').replace(/0+$/, '');
        return fracStr ? `${whole}.${fracStr}` : `${whole}.0`;
      };
      return {
        type:      e.type,
        validator: e.validator ?? null,
        amount:    weiToHype(e.wei),
        time:      e.timestamp,
      };
    } catch {
      return null;
    }
  }).filter(Boolean); // lpush stores newest-first, so no .reverse() needed
}

/**
 * Returns delegator rewards for a user.
 * HyPaper doesn't simulate staking rewards — returns empty/zero values.
 * Real HL /info delegatorRewards response shape:
 * { "pendingRewards": "0.0", "totalRewards": "0.0", "rewardHistory": [] }
 */
export async function getDelegatorRewards(userId: string): Promise<unknown> {
  // HyPaper has no reward simulation — return zeros with correct shape
  return {
    pendingRewards: '0.0',
    totalRewards:   '0.0',
    rewardHistory:  [],
  };
}

// ─── Helper: append staking event ────────────────────────────────────────────

async function appendStakingEvent(userId: string, event: Record<string, unknown>): Promise<void> {
  const key   = KEYS.STAKING_EVENTS(userId);
  const entry = JSON.stringify(event);
  // lpush prepends (newest first), keep max 200 events per user
  await redis.lpush(key, entry);
  await redis.ltrim(key, 0, 199);
}

// ─── StakingWorker helper — sweep 7-day queue ────────────────────────────────
// Called by the StakingWorker in src/worker/index.ts every 60 seconds.
// Finds all queue entries whose unlockTime has passed and completes them
// by crediting the wei back to the user's spot balance (USER_ACCOUNT "balance").
//
// Design note: HyPaper does not maintain a separate HYPE spot-balance bucket
// (USER_ACCOUNT tracks USDC only). Completed unstake withdrawals are therefore
// credited back into the unified USER_ACCOUNT balance, which mirrors the net
// effect on the user's available funds in paper-trading mode.

export async function sweepStakingQueue(): Promise<void> {
  const now = Date.now();
  let cursor = '0';

  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH', 'user:*:staking_queue',
      'COUNT', 100,
    );
    cursor = nextCursor;

    for (const key of keys) {
      // Get all entries whose score (unlockTime) <= now
      const ready = await redis.zrangebyscore(key, '-inf', now) as string[];
      if (!ready.length) continue;

      // Extract userId from key: user:{userId}:staking_queue
      const parts  = key.split(':');
      if (parts.length < 3) continue;
      const userId = parts[1];

      for (const raw of ready) {
        try {
          const entry  = JSON.parse(raw);
          // Completed withdrawals go back to the user's spot/unified balance,
          // not staking balance — the 7-day lock has expired and the funds
          // are fully liquid again.
          const spotKey    = KEYS.USER_ACCOUNT(userId);
          const currentRaw = await redis.hget(spotKey, 'balance');
          const current    = parseFloat(currentRaw ?? '0');
          // Convert from wei to HYPE units (1 HYPE = 1e8 wei)
          const hypeAmount = Number(BigInt(entry.wei)) / 1e8;
          const updated    = (current + hypeAmount).toFixed(6);

          const pipeline = redis.pipeline();
          pipeline.hset(spotKey, 'balance', updated);
          pipeline.zrem(key, raw);
          await pipeline.exec();

          await appendStakingEvent(userId, {
            type:      'withdrawalComplete',
            wei:       entry.wei,
            timestamp: Date.now(),
          });

          logger.info({ userId, wei: entry.wei, hypeAmount }, 'StakingWorker — 7-day withdrawal completed, credited to spot balance');
        } catch (err) {
          logger.error({ err, key }, 'StakingWorker — error processing queue entry');
        }
      }
    }
  } while (cursor !== '0');
}