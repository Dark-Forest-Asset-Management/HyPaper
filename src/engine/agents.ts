/**
 * src/engine/agents.ts
 *
 * Engine functions:
 *   approveAgent      — authorize an API wallet to sign on behalf of master
 *   approveBuilderFee — set max fee rate for a builder address
 *   setReferrer       — record a referral code for a user
 *
 * ── approveAgent ──────────────────────────────────────────────────────────────
 * An "agent" (also called API wallet) is a separate wallet that can sign
 * transactions on behalf of a master account. This is used for programmatic
 * trading while keeping the master private key secure.
 *
 * HL allows:
 *   - 1 unnamed agent (agentName omitted or empty)
 *   - Up to 10 named agents (each identified by agentName string)
 *   - Sending approveAgent with an existing name REPLACES that agent
 *   - Sending approveAgent with a new name ADDS a new named agent
 *   - To revoke: send approveAgent with agentAddress = zero address
 *
 * HyPaper stores agents in a Redis hash per user:
 *   USER_AGENTS(userId)  →  hash of agentAddress → JSON { agentName, approvedAt }
 * The unnamed agent is stored under key "__unnamed__".
 *
 * ── approveBuilderFee ─────────────────────────────────────────────────────────
 * Builders are application developers who receive a fee on fills they route.
 * The user approves a maxFeeRate per builder address. The builder can then
 * charge up to that rate on orders they place on behalf of the user.
 *
 * HyPaper stores per-builder max fee rates in a Redis hash per user:
 *   USER_BUILDER_FEES(userId)  →  hash of builderAddress → maxFeeRate string
 *
 * ── setReferrer ───────────────────────────────────────────────────────────────
 * Records a referral code for a user. In real HL this links the user to a
 * referrer who earns a share of trading fees. HyPaper stores it and serves
 * it back via /info referral.
 *
 * HyPaper stores:
 *   USER_REFERRER(userId)  →  string: the referral code
 */

import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';

// ── Limits (matching real HL) ─────────────────────────────────────────────────
const MAX_NAMED_AGENTS   = 10;
const UNNAMED_AGENT_KEY  = '__unnamed__';

// ─── approveAgent ─────────────────────────────────────────────────────────────

export async function approveAgent(
  masterUserId: string,
  agentAddress: string,
  agentName:    string | undefined,
): Promise<{ ok: true } | { error: string }> {
  const agentAddr = agentAddress.toLowerCase();

  // Zero address = revoke
  const isRevoke = agentAddr === '0x0000000000000000000000000000000000000000';

  const agentsKey = KEYS.USER_AGENTS(masterUserId);

  if (isRevoke) {
    // Revoke: remove the agent identified by name (or unnamed if no name)
    const storageKey = agentName?.trim() ? agentName.trim() : UNNAMED_AGENT_KEY;
    await redis.hdel(agentsKey, storageKey);
    logger.info({ masterUserId, agentName, storageKey }, 'approveAgent — revoked');
    return { ok: true };
  }

  if (!agentName?.trim()) {
    // Unnamed agent — only 1 allowed, replaces previous unnamed
    const entry = JSON.stringify({ agentAddress: agentAddr, agentName: '', approvedAt: Date.now() });
    await redis.hset(agentsKey, UNNAMED_AGENT_KEY, entry);
    logger.info({ masterUserId, agentAddr }, 'approveAgent — unnamed agent set');
    return { ok: true };
  }

  const trimmedName = agentName.trim();

  // Named agent — check if this name already exists (replace) or is new (add)
  const existing = await redis.hget(agentsKey, trimmedName);
  if (!existing) {
    // New name — check limit
    const allAgents = await redis.hgetall(agentsKey);
    const namedCount = Object.keys(allAgents).filter(k => k !== UNNAMED_AGENT_KEY).length;
    if (namedCount >= MAX_NAMED_AGENTS) {
      return { error: `Named agent limit reached (max ${MAX_NAMED_AGENTS}). Revoke an existing agent first.` };
    }
  }

  const entry = JSON.stringify({ agentAddress: agentAddr, agentName: trimmedName, approvedAt: Date.now() });
  await redis.hset(agentsKey, trimmedName, entry);
  logger.info({ masterUserId, agentAddr, agentName: trimmedName }, 'approveAgent — named agent set');
  return { ok: true };
}

// ─── getExtraAgents ───────────────────────────────────────────────────────────
// Returns the list of approved agents for a user.
// Real HL /info extraAgents response shape (confirmed from docs):
// [
//   { "address": "0x...", "name": "AGENT_NAME", "validUntil": null },
//   ...
// ]

export async function getExtraAgents(masterUserId: string): Promise<unknown[]> {
  const agentsKey = KEYS.USER_AGENTS(masterUserId);
  const raw       = await redis.hgetall(agentsKey);

  if (!raw || Object.keys(raw).length === 0) return [];

  return Object.entries(raw as Record<string, string>).map(([storageKey, json]) => {
    try {
      const parsed = JSON.parse(json) as { agentAddress: string; agentName: string; approvedAt: number };
      return {
        address:    parsed.agentAddress,
        name:       storageKey === UNNAMED_AGENT_KEY ? '' : parsed.agentName,
        validUntil: null,   // HyPaper doesn't enforce time-limited agents
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// ─── approveBuilderFee ────────────────────────────────────────────────────────

export async function approveBuilderFee(
  userId:      string,
  builder:     string,
  maxFeeRate:  string,
): Promise<{ ok: true } | { error: string }> {
  const builderAddr = builder.toLowerCase();

  // Validate maxFeeRate format — HL uses basis-point strings like "0.001%"
  // We store it as-is and validate it's a non-empty string
  if (!maxFeeRate || typeof maxFeeRate !== 'string') {
    return { error: 'maxFeeRate must be a non-empty string (e.g. "0.001%")' };
  }

  await redis.hset(KEYS.USER_BUILDER_FEES(userId), builderAddr, maxFeeRate);
  logger.info({ userId, builderAddr, maxFeeRate }, 'approveBuilderFee — stored');
  return { ok: true };
}

// ─── getMaxBuilderFee ─────────────────────────────────────────────────────────
// Returns the max fee rate the user has approved for a specific builder.
// Real HL /info maxBuilderFee response shape:
// { "maxFeeRate": "0.001%" }  — or null if not approved

export async function getMaxBuilderFee(
  userId:  string,
  builder: string,
): Promise<{ maxFeeRate: string } | null> {
  const builderAddr  = builder.toLowerCase();
  const maxFeeRate   = await redis.hget(KEYS.USER_BUILDER_FEES(userId), builderAddr);
  if (!maxFeeRate) return null;
  return { maxFeeRate };
}

// ─── getBuilderFeeApproval ────────────────────────────────────────────────────
// Returns whether the user has approved a specific builder fee and the rate.
// Real HL /info builderFeeApproval response shape:
// { "builder": "0x...", "maxFeeRate": "0.001%", "approved": true }
// — or { "approved": false } if not approved

export async function getBuilderFeeApproval(
  userId:  string,
  builder: string,
): Promise<{ builder: string; maxFeeRate: string; approved: true } | { approved: false }> {
  const builderAddr = builder.toLowerCase();
  const maxFeeRate  = await redis.hget(KEYS.USER_BUILDER_FEES(userId), builderAddr);

  if (!maxFeeRate) return { approved: false };
  return { builder: builderAddr, maxFeeRate, approved: true };
}

// ─── setReferrer ──────────────────────────────────────────────────────────────

export async function setReferrer(
  userId: string,
  code:   string,
): Promise<{ ok: true } | { error: string }> {
  if (!code || typeof code !== 'string' || !code.trim()) {
    return { error: 'Referral code must be a non-empty string' };
  }

  await redis.set(KEYS.USER_REFERRER(userId), code.trim());
  logger.info({ userId, code: code.trim() }, 'setReferrer — stored');
  return { ok: true };
}

// ─── getReferral ──────────────────────────────────────────────────────────────
// Returns the referral state for a user.
// Real HL /info referral response shape (confirmed from HL docs):
// {
//   "referrerState": {
//     "data": { "code": "MYCODE", "builderCode": null },
//     "stage": "percentageReferrer"    (or "noReferrer" if none set)
//   },
//   "referredBy": { "referrer": "0x...", "code": "THEIRCODE" } | null,
//   "cumVlm": "0.0",
//   "rewardHistory": []
// }

export async function getReferral(userId: string): Promise<unknown> {
  const code = await redis.get(KEYS.USER_REFERRER(userId));

  return {
    referrerState: code
      ? {
          data:  { code, builderCode: null },
          stage: 'percentageReferrer',
        }
      : {
          data:  null,
          stage: 'noReferrer',
        },
    referredBy:    null,   // HyPaper doesn't track who referred whom
    cumVlm:        '0.0',
    rewardHistory: [],
  };
}