/**
 * src/engine/transfers.ts
 *
 * Engine functions for transfer actions:
 *   usdClassTransfer  — spot ↔ perp USDC balance move (+ subaccount suffix parse)
 *   usdSend           — perp USDC → another wallet's perp balance
 *   spotSend          — spot token → another wallet
 *   sendAsset         — generalised cross-DEX/cross-user transfer (incl. EVM debit)
 *   agentSendAsset    — same as sendAsset, signed by an agent wallet
 *   sendToEvmWithData — HyperCore → HyperEVM with calldata (debits sender balance)
 *
 * ── UNIFIED ACCOUNT NOTE ──────────────────────────────────────────────────────
 * Real HL disables usdClassTransfer, usdSend, and spotSend when a unified
 * account is active. HyPaper doesn't track unified-account status — every
 * action is available in paper mode, which is correct for Slushy.trade users.
 *
 * ── BALANCE MODEL ─────────────────────────────────────────────────────────────
 * HyPaper uses a single unified balance bucket per user:
 *   USER_ACCOUNT(userId) hash field "balance" — USDC balance (spot + perp unified)
 *
 * Real HL separates spot and perp books. In paper trading we keep one bucket
 * and treat usdClassTransfer as a no-op (no real funds move between books).
 * sendAsset from either "spot" or "" (perp) both draw from this same bucket.
 *
 * ── SUBACCOUNT SUFFIX ENCODING ────────────────────────────────────────────────
 * When HL performs a usdClassTransfer involving a sub-account, the amount field
 * carries a suffix encoding the sub-account address:
 *   amount = "<dollars> subaccount:<0xADDR>"
 * The outer request body also includes: vaultAddress: "<0xADDR>"
 *
 * parseAmountWithSubaccount() extracts both the numeric amount and the optional
 * sub-account address from this encoded string.
 */

import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';

// ─── Subaccount suffix parser ─────────────────────────────────────────────────
//
// Parses HL's subaccount-suffix amount encoding.
// Input examples:
//   "5"                              → { amountNum: 5, subAccount: null }
//   "5 subaccount:0x1234...abcd"     → { amountNum: 5, subAccount: "0x1234...abcd" }
//
// This is used by usdClassTransfer to route funds to/from the correct
// sub-account balance when a sub-account suffix is present.

export function parseAmountWithSubaccount(
  raw: string,
): { amountNum: number; subAccount: string | null } {
  const trimmed = raw.trim();

  // Check for subaccount suffix
  const SUFFIX = ' subaccount:';
  const idx = trimmed.indexOf(SUFFIX);

  if (idx === -1) {
    // Plain amount, no suffix
    const amountNum = parseFloat(trimmed);
    return { amountNum, subAccount: null };
  }

  const amountPart   = trimmed.slice(0, idx).trim();
  const subAccPart   = trimmed.slice(idx + SUFFIX.length).trim().toLowerCase();
  const amountNum    = parseFloat(amountPart);

  return { amountNum, subAccount: subAccPart || null };
}

// ─── usdClassTransfer ─────────────────────────────────────────────────────────
//
// Moves USDC between spot and perp balances.
//
// In HyPaper: spot and perp share the same balance bucket, so a plain
// usdClassTransfer is acknowledged without moving funds.
//
// SUBACCOUNT SUFFIX HANDLING:
// When amount contains " subaccount:<0xADDR>", it means the transfer is
// moving funds between the master account and a sub-account. HyPaper routes
// the actual debit/credit to the correct account addresses.
//
//   toPerp: true  = sub-account → master  (sub-account pays, master receives)
//   toPerp: false = master → sub-account  (master pays, sub-account receives)
//
// Real HL response on success: { status: "ok", response: { type: "default" } }

export async function usdClassTransfer(
  userId:  string,
  amount:  string,
  toPerp:  boolean,
): Promise<{ ok: true } | { error: string }> {
  const { amountNum, subAccount } = parseAmountWithSubaccount(amount);

  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return { error: 'Amount must be a positive number' };
  }

  if (subAccount) {
    // Sub-account suffix present — route funds between master and sub-account.
    // toPerp: true  = moving from sub-account into master perp balance
    // toPerp: false = moving from master into sub-account
    const senderKey   = toPerp
      ? KEYS.USER_ACCOUNT(subAccount)   // sub-account sends to master
      : KEYS.USER_ACCOUNT(userId);      // master sends to sub-account
    const receiverKey = toPerp
      ? KEYS.USER_ACCOUNT(userId)       // master receives
      : KEYS.USER_ACCOUNT(subAccount);  // sub-account receives

    const senderRaw = await redis.hgetall(senderKey);
    const senderBal = parseFloat(senderRaw.balance ?? '0');

    if (senderBal < amountNum) {
      return {
        error: `Insufficient balance: have ${senderBal.toFixed(6)}, need ${amountNum.toFixed(6)}`,
      };
    }

    const receiverRaw = await redis.hgetall(receiverKey);
    const receiverBal = parseFloat(receiverRaw.balance ?? '0');

    const pipeline = redis.pipeline();
    pipeline.hset(senderKey,   'balance', (senderBal   - amountNum).toFixed(6));
    pipeline.hset(receiverKey, 'balance', (receiverBal + amountNum).toFixed(6));
    await pipeline.exec();

    logger.info(
      { userId, subAccount, amountNum, toPerp },
      'usdClassTransfer — subaccount routing executed',
    );
    return { ok: true };
  }

  // No sub-account suffix — plain spot↔perp transfer.
  // HyPaper uses one unified balance bucket, so this is a no-op.
  logger.info({ userId, amount, toPerp }, 'usdClassTransfer acknowledged (unified balance)');
  return { ok: true };
}

// ─── usdSend ──────────────────────────────────────────────────────────────────
//
// Sends USDC from sender's perp balance to recipient's perp balance.
// If recipient is a known HyPaper user, credits them too.
// If recipient is unknown, only debits the sender.
//
// Real HL response: { status: "ok", response: { type: "default" } }

export async function usdSend(
  senderUserId: string,
  destination:  string,
  amount:       string,
): Promise<{ ok: true } | { error: string }> {
  const amountNum = parseFloat(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return { error: 'Amount must be a positive number' };
  }

  const destAddr  = destination.toLowerCase();
  const senderKey = KEYS.USER_ACCOUNT(senderUserId);
  const senderRaw = await redis.hgetall(senderKey);
  const senderBal = parseFloat(senderRaw.balance ?? '0');

  if (senderBal < amountNum) {
    return {
      error: `Insufficient balance: have ${senderBal.toFixed(6)}, need ${amountNum.toFixed(6)}`,
    };
  }

  const pipeline = redis.pipeline();
  pipeline.hset(senderKey, 'balance', (senderBal - amountNum).toFixed(6));

  // Credit recipient if they are a known HyPaper account
  const recipientRaw = await redis.hgetall(KEYS.USER_ACCOUNT(destAddr));
  if (recipientRaw.balance !== undefined) {
    const newRecipientBal = (parseFloat(recipientRaw.balance) + amountNum).toFixed(6);
    pipeline.hset(KEYS.USER_ACCOUNT(destAddr), 'balance', newRecipientBal);
    logger.info({ senderUserId, destAddr, amountNum }, 'usdSend — credited known recipient');
  } else {
    logger.info({ senderUserId, destAddr, amountNum }, 'usdSend — recipient unknown, debit only');
  }

  await pipeline.exec();
  return { ok: true };
}

// ─── spotSend ─────────────────────────────────────────────────────────────────
//
// Sends a spot token to another wallet.
// For USDC: debits sender, credits recipient if known (same as usdSend).
// For other tokens: acknowledged only (no multi-token balance simulation).
//
// Real HL response: { status: "ok", response: { type: "default" } }

export async function spotSend(
  senderUserId: string,
  destination:  string,
  token:        string,
  amount:       string,
): Promise<{ ok: true } | { error: string }> {
  const amountNum = parseFloat(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return { error: 'Amount must be a positive number' };
  }
  if (!token || !token.includes(':')) {
    return { error: 'Invalid token format — expected NAME:0xTOKENID' };
  }

  // For USDC spot sends: debit/credit the unified balance bucket.
  const isUsdc = token.toLowerCase().startsWith('usdc:');
  if (isUsdc) {
    const senderKey = KEYS.USER_ACCOUNT(senderUserId);
    const senderRaw = await redis.hgetall(senderKey);
    const senderBal = parseFloat(senderRaw.balance ?? '0');

    if (senderBal < amountNum) {
      return {
        error: `Insufficient USDC balance: have ${senderBal.toFixed(6)}, need ${amountNum.toFixed(6)}`,
      };
    }

    const pipeline  = redis.pipeline();
    pipeline.hset(senderKey, 'balance', (senderBal - amountNum).toFixed(6));

    const destAddr     = destination.toLowerCase();
    const recipientRaw = await redis.hgetall(KEYS.USER_ACCOUNT(destAddr));
    if (recipientRaw.balance !== undefined) {
      const newBal = (parseFloat(recipientRaw.balance) + amountNum).toFixed(6);
      pipeline.hset(KEYS.USER_ACCOUNT(destAddr), 'balance', newBal);
      logger.info({ senderUserId, destAddr, amountNum }, 'spotSend USDC — credited known recipient');
    }
    await pipeline.exec();
  }

  // Non-USDC tokens: acknowledged only (no balance tracking).
  logger.info({ senderUserId, destination, token, amount }, 'spotSend executed');
  return { ok: true };
}

// ─── sendAsset ────────────────────────────────────────────────────────────────
//
// Generalised asset transfer between DEXs, users, and sub-accounts.
// sourceDex / destinationDex values:
//   ""     = default USDC perp DEX
//   "spot" = spot balance (HyPaper unified bucket)
//   "evm"  = HyperEVM
//
// EVM destination: debits the sender's balance (funds leave HyperCore).
//   No EVM balance is tracked in HyPaper, but the debit is real.
// Cross-user transfer: debit sender, credit recipient if known.
// Same-user transfer: rejected ("Invalid send") — matches real HL.
//
// Real HL success response: { status: "ok", response: { type: "default" } }

export async function sendAsset(
  senderUserId:   string,
  destination:    string,
  sourceDex:      string,
  destinationDex: string,
  token:          string,
  amount:         string,
  fromSubAccount: string,
): Promise<{ ok: true } | { error: string }> {
  const amountNum = parseFloat(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return { error: 'Amount must be a positive number' };
  }

  const destAddr = destination.toLowerCase();

  // Self-transfer not allowed (matches real HL "Invalid send" error)
  if (destAddr === senderUserId.toLowerCase()) {
    return { error: 'Invalid send' };
  }

  // Determine actual sender key — fromSubAccount means funds come from sub-account
  const actualSenderKey = fromSubAccount
    ? KEYS.USER_ACCOUNT(fromSubAccount.toLowerCase())
    : KEYS.USER_ACCOUNT(senderUserId);

  const senderRaw = await redis.hgetall(actualSenderKey);
  const senderBal = parseFloat(senderRaw.balance ?? '0');

  if (senderBal < amountNum) {
    return {
      error: `Insufficient balance: have ${senderBal.toFixed(6)}, need ${amountNum.toFixed(6)}`,
    };
  }

  const pipeline = redis.pipeline();
  pipeline.hset(actualSenderKey, 'balance', (senderBal - amountNum).toFixed(6));

  if (destinationDex === 'evm') {
    // EVM destination: funds leave HyperCore — debit sender, no EVM credit tracked.
    await pipeline.exec();
    logger.info(
      { senderUserId, destAddr, token, amount },
      'sendAsset → evm: sender debited, EVM balance not tracked in HyPaper',
    );
    return { ok: true };
  }

  // Non-EVM: credit recipient if they are a known HyPaper account
  const recipientRaw = await redis.hgetall(KEYS.USER_ACCOUNT(destAddr));
  if (recipientRaw.balance !== undefined) {
    const newRecipientBal = (parseFloat(recipientRaw.balance) + amountNum).toFixed(6);
    pipeline.hset(KEYS.USER_ACCOUNT(destAddr), 'balance', newRecipientBal);
    logger.info({ senderUserId, destAddr, amountNum }, 'sendAsset — credited known recipient');
  } else {
    logger.info({ senderUserId, destAddr, amountNum }, 'sendAsset — recipient unknown, debit only');
  }

  await pipeline.exec();
  return { ok: true };
}

// ─── agentSendAsset ───────────────────────────────────────────────────────────
//
// Same as sendAsset but signed by an agent wallet (Pattern A — L1 Agent).
// In real HL, the agent can only send to the master account or its sub-accounts.
// In HyPaper paper mode we don't enforce agent registration — routes to sendAsset.

export async function agentSendAsset(
  agentUserId:    string,
  destination:    string,
  sourceDex:      string,
  destinationDex: string,
  token:          string,
  amount:         string,
  fromSubAccount: string,
): Promise<{ ok: true } | { error: string }> {
  return sendAsset(
    agentUserId,
    destination,
    sourceDex,
    destinationDex,
    token,
    amount,
    fromSubAccount,
  );
}

// ─── sendToEvmWithData ────────────────────────────────────────────────────────
//
// Sends a token from HyperCore to HyperEVM with arbitrary calldata.
//
// Paper accounting: debits the sender's balance (funds leave HyperCore).
// No HyperEVM balance is tracked in HyPaper, but the debit is applied
// so the sender's balance accurately reflects the outgoing transfer.
//
// Real HL success response: { status: "ok", response: { type: "default" } }

export async function sendToEvmWithData(
  userId:               string,
  token:                string,
  amount:               string,
  sourceDex:            string,
  destinationRecipient: string,
  destinationChainId:   number,
  gasLimit:             number,
  data:                 string,
): Promise<{ ok: true } | { error: string }> {
  const amountNum = parseFloat(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return { error: 'Amount must be a positive number' };
  }

  // Debit the sender's balance — funds leave HyperCore.
  const userKey = KEYS.USER_ACCOUNT(userId);
  const userRaw = await redis.hgetall(userKey);
  const userBal = parseFloat(userRaw.balance ?? '0');

  if (userBal < amountNum) {
    return {
      error: `Insufficient balance: have ${userBal.toFixed(6)}, need ${amountNum.toFixed(6)}`,
    };
  }

  await redis.hset(userKey, 'balance', (userBal - amountNum).toFixed(6));

  logger.info(
    { userId, token, amount, destinationRecipient, destinationChainId },
    'sendToEvmWithData — sender debited, EVM balance not tracked in HyPaper',
  );
  return { ok: true };
}