import { Hono } from 'hono';
import {
  placeOrders,
  cancelOrders,
  cancelByCloid,
  updateLeverage,
  updateIsolatedMargin,
  scheduleCancel,
  modifyOrder,
  batchModifyOrders,
  createTwapOrder,
  cancelTwapOrder,
} from '../../engine/order.js';
import {
  createSubAccount,
  subAccountTransfer,
  subAccountSpotTransfer,
  vaultTransfer,
} from '../../engine/subaccount.js';
import {
  usdClassTransfer,
  usdSend,
  spotSend,
  sendAsset,
  agentSendAsset,
  sendToEvmWithData,
} from '../../engine/transfers.js';
import {
  approveAgent,
  approveBuilderFee,
  setReferrer,
} from '../../engine/agents.js';
import {
  cDeposit,
  cWithdraw,
  tokenDelegate,
} from '../../engine/staking.js';
import { ensureAccount } from '../middleware/auth.js';
import { recoverHlSigner } from '../middleware/recoverHlSigner.js';
import { recoverUserSignedAction, isUserSignedActionType } from '../middleware/recoverUserSignedAction.js';
import { logger } from '../../utils/logger.js';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import type { HlExchangeAction, HlOrderWire } from '../../types/hl.js';

export const exchangeRouter = new Hono();

/** HL cloid format: 0x-prefixed 16-byte (32 hex chars) — total length 34. */
const CLOID_RE = /^0x[0-9a-fA-F]{32}$/;

/** Validate a single order wire (used by `order`, `modify`, `batchModify`). */
function validateOrderWire(o: HlOrderWire): string | null {
  if (typeof o.a !== 'number' || typeof o.b !== 'boolean' ||
      typeof o.p !== 'string' || typeof o.s !== 'string' ||
      typeof o.r !== 'boolean') {
    return 'Invalid order wire format';
  }
  const hasLimit   = !!o.t?.limit?.tif;
  const hasTrigger = !!o.t?.trigger;
  if (!hasLimit && !hasTrigger) return 'Order must include t.limit.tif or t.trigger';
  if (hasTrigger) {
    const trig = o.t.trigger!;
    if (typeof trig.isMarket !== 'boolean' || typeof trig.triggerPx !== 'string' ||
        (trig.tpsl !== 'tp' && trig.tpsl !== 'sl')) {
      return 'Invalid trigger config: need isMarket, triggerPx, tpsl';
    }
  }
  if (o.c !== undefined && (typeof o.c !== 'string' || !CLOID_RE.test(o.c))) {
    return 'cloid must be 0x-prefixed 16-byte hex (34 chars)';
  }
  const size  = Number(o.s);
  const price = Number(o.p);
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
    return 'Size and price must be finite positive numbers';
  }
  return null;
}

exchangeRouter.post('/', async (c) => {
  const body = await c.req.json();

  // Derive the wallet from the EIP-712 signature when present (production path).
  // Fall back to `body.wallet` only for unsigned local tests / scripts.
  let wallet: string;
  if (body.signature && body.action && typeof body.nonce === 'number') {
    try {
      // User-signed actions (transfers/approvals/staking) use a different
      // EIP-712 scheme than L1 actions — route by action type.
      wallet = isUserSignedActionType(body.action.type)
        ? recoverUserSignedAction(body.action, body.signature)
        : recoverHlSigner(body.action, body.nonce, body.signature, body.vaultAddress);
    } catch (err) {
      return c.json({
        status: 'err',
        response: `Signature recovery failed: ${(err as Error).message}`,
      }, 400);
    }
  } else if (typeof body.wallet === 'string') {
    wallet = body.wallet.toLowerCase();
  } else {
    return c.json({ status: 'err', response: 'Missing signature (or wallet for unsigned tests)' }, 400);
  }

  await ensureAccount(wallet);

  // vaultAddress — when present the signer is acting on behalf of a vault or
  // sub-account. We treat it as the effective acting wallet for this request.
  let effectiveWallet = wallet;
  if (body.vaultAddress && typeof body.vaultAddress === 'string') {
    effectiveWallet = body.vaultAddress.toLowerCase();
    await ensureAccount(effectiveWallet);
  }

  // Replay protection
  if (typeof body.nonce === 'number' && Number.isFinite(body.nonce)) {
    const prevStr = await redis.get(KEYS.USER_NONCE_MAX(wallet));
    const prev    = prevStr ? parseInt(prevStr, 10) : 0;
    if (body.nonce <= prev) {
      return c.json({ status: 'err', response: `Nonce ${body.nonce} ≤ previous ${prev} (replay)` }, 400);
    }
    await redis.set(KEYS.USER_NONCE_MAX(wallet), String(body.nonce));
  }

  const expiresAfter: number | undefined =
    typeof body.expiresAfter === 'number' && Number.isFinite(body.expiresAfter)
      ? body.expiresAfter
      : undefined;

  if (expiresAfter !== undefined && expiresAfter <= Date.now()) {
    return c.json({ status: 'err', response: 'expiresAfter is in the past' }, 400);
  }

  const action: HlExchangeAction = body.action;
  if (!action || typeof action !== 'object' || !action.type) {
    return c.json({ status: 'err', response: 'Missing or invalid action' }, 400);
  }

  try {
    switch (action.type) {

      // ── order ────────────────────────────────────────────────────────────

      case 'order': {
        if (!Array.isArray(action.orders) || action.orders.length === 0) {
          return c.json({ status: 'err', response: 'Missing orders array' }, 400);
        }
        if (action.orders.length > 50) {
          return c.json({ status: 'err', response: 'Max 50 orders per request' }, 400);
        }
        for (const o of action.orders) {
          const err = validateOrderWire(o);
          if (err) return c.json({ status: 'err', response: err }, 400);
        }
        // HL's optional action-level `{builder:{b,f}}` — same builder applies
        // to every order in the batch. Validate shape so a malformed entry
        // doesn't cascade into NaN fees in executeFill.
        let builder: { b: string; f: number } | undefined;
        if (action.builder !== undefined) {
          const b = action.builder as unknown as { b?: unknown; f?: unknown };
          if (
            !b || typeof b !== 'object' ||
            typeof b.b !== 'string' || typeof b.f !== 'number' ||
            !Number.isFinite(b.f) || b.f < 0
          ) {
            return c.json({ status: 'err', response: 'Invalid builder: expected {b: address, f: number (tenths of bps)}' }, 400);
          }
          builder = { b: b.b, f: b.f };
        }
        const statuses = await placeOrders(effectiveWallet, action.orders, action.grouping ?? 'na', { expiresAfter, builder });
        return c.json({ status: 'ok', response: { type: 'order', data: { statuses } } });
      }

      // ── cancel ───────────────────────────────────────────────────────────

      case 'cancel': {
        if (!Array.isArray(action.cancels) || action.cancels.length === 0) {
          return c.json({ status: 'err', response: 'Missing cancels array' }, 400);
        }
        for (const cancel of action.cancels) {
          if (typeof cancel.a !== 'number' || typeof cancel.o !== 'number') {
            return c.json({ status: 'err', response: 'Invalid cancel format: need a (asset) and o (oid)' }, 400);
          }
        }
        const statuses = await cancelOrders(effectiveWallet, action.cancels);
        return c.json({ status: 'ok', response: { type: 'cancel', data: { statuses } } });
      }

      // ── cancelByCloid ────────────────────────────────────────────────────

      case 'cancelByCloid': {
        if (!Array.isArray(action.cancels) || action.cancels.length === 0) {
          return c.json({ status: 'err', response: 'Missing cancels array' }, 400);
        }
        for (const cancel of action.cancels) {
          if (typeof cancel.asset !== 'number' || typeof cancel.cloid !== 'string') {
            return c.json({ status: 'err', response: 'Invalid cancelByCloid format: need asset and cloid' }, 400);
          }
        }
        const statuses = await cancelByCloid(effectiveWallet, action.cancels);
        return c.json({ status: 'ok', response: { type: 'cancel', data: { statuses } } });
      }

      // ── modify ───────────────────────────────────────────────────────────

      case 'modify': {
        if (typeof action.oid !== 'number' && typeof action.oid !== 'string') {
          return c.json({ status: 'err', response: 'modify requires oid (number or cloid string)' }, 400);
        }
        if (typeof action.oid === 'string' && !CLOID_RE.test(action.oid)) {
          return c.json({ status: 'err', response: 'modify cloid must be 0x-prefixed 16-byte hex' }, 400);
        }
        const wireErr = validateOrderWire(action.order);
        if (wireErr) return c.json({ status: 'err', response: wireErr }, 400);

        let numericOid: number;
        if (typeof action.oid === 'string') {
          const oidStr = await redis.hget(KEYS.USER_CLOIDS(effectiveWallet), action.oid);
          if (!oidStr) return c.json({ status: 'err', response: `cloid ${action.oid} not found` }, 400);
          numericOid = parseInt(oidStr, 10);
        } else {
          numericOid = action.oid;
        }

        const result = await modifyOrder(effectiveWallet, numericOid, action.order);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── batchModify ──────────────────────────────────────────────────────

      case 'batchModify': {
        if (!Array.isArray(action.modifies) || action.modifies.length === 0) {
          return c.json({ status: 'err', response: 'Missing modifies array' }, 400);
        }
        for (const m of action.modifies) {
          if (typeof m.oid !== 'number' && typeof m.oid !== 'string') {
            return c.json({ status: 'err', response: 'Each modify needs valid oid' }, 400);
          }
          if (typeof m.oid === 'string' && !CLOID_RE.test(m.oid)) {
            return c.json({ status: 'err', response: 'modify cloid must be 0x-prefixed 16-byte hex' }, 400);
          }
          const err = validateOrderWire(m.order);
          if (err) return c.json({ status: 'err', response: err }, 400);
        }

        const resolved: Array<{ oid: number; order: HlOrderWire }> = [];
        for (const m of action.modifies) {
          let numericOid: number;
          if (typeof m.oid === 'string') {
            const oidStr = await redis.hget(KEYS.USER_CLOIDS(effectiveWallet), m.oid);
            if (!oidStr) {
              resolved.push({ oid: -1, order: m.order });
              continue;
            }
            numericOid = parseInt(oidStr, 10);
          } else {
            numericOid = m.oid;
          }
          resolved.push({ oid: numericOid, order: m.order });
        }

        const statuses = await batchModifyOrders(effectiveWallet, resolved);
        return c.json({ status: 'ok', response: { type: 'order', data: { statuses } } });
      }

      // ── twapOrder ────────────────────────────────────────────────────────

      case 'twapOrder': {
        if (!action.twap || typeof action.twap !== 'object') {
          return c.json({ status: 'err', response: 'twapOrder requires twap object' }, 400);
        }
        const t = action.twap;
        if (typeof t.a !== 'number' || typeof t.b !== 'boolean' ||
            typeof t.s !== 'string' || typeof t.r !== 'boolean' ||
            typeof t.m !== 'number' || typeof t.t !== 'boolean') {
          return c.json({ status: 'err', response: 'twap requires fields: a, b, s, r, m, t' }, 400);
        }
        if (t.m < 5) {
          return c.json({ status: 'err', response: 'TWAP duration minimum is 5 minutes' }, 400);
        }
        const twapResult = await createTwapOrder(effectiveWallet, t.a, t.b, t.s, t.r, t.m);
        if ('error' in twapResult) {
          return c.json({ status: 'ok', response: { type: 'twapOrder', data: { status: { error: twapResult.error } } } });
        }
        return c.json({
          status: 'ok',
          response: { type: 'twapOrder', data: { status: { running: { twapId: twapResult.twapId } } } },
        });
      }

      // ── twapCancel ───────────────────────────────────────────────────────

      case 'twapCancel': {
        if (typeof action.a !== 'number' || typeof action.t !== 'number') {
          return c.json({ status: 'err', response: 'twapCancel requires a (asset) and t (twapId)' }, 400);
        }
        const cancelResult = await cancelTwapOrder(effectiveWallet, action.t);
        if ('error' in cancelResult) {
          return c.json({ status: 'err', response: cancelResult.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'twapCancel', data: { status: 'success' } } });
      }

      // ── updateLeverage ───────────────────────────────────────────────────

      case 'updateLeverage': {
        if (typeof action.asset !== 'number' || typeof action.leverage !== 'number' ||
            typeof action.isCross !== 'boolean') {
          return c.json({ status: 'err', response: 'updateLeverage requires asset, leverage, isCross' }, 400);
        }
        if (action.leverage < 1 || action.leverage > 200) {
          return c.json({ status: 'err', response: 'Leverage must be between 1 and 200' }, 400);
        }
        await updateLeverage(effectiveWallet, action.asset, action.isCross, action.leverage);
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── updateIsolatedMargin ─────────────────────────────────────────────

      case 'updateIsolatedMargin': {
        if (typeof action.asset !== 'number' || typeof action.isBuy !== 'boolean' ||
            typeof action.ntli !== 'number') {
          return c.json({ status: 'err', response: 'updateIsolatedMargin requires asset, isBuy, ntli' }, 400);
        }
        const marginResult = await updateIsolatedMargin(effectiveWallet, action.asset, action.isBuy, action.ntli);
        if ('error' in marginResult) {
          return c.json({ status: 'err', response: marginResult.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── scheduleCancel ───────────────────────────────────────────────────

      case 'scheduleCancel': {
        if (action.time !== undefined && typeof action.time !== 'number') {
          return c.json({ status: 'err', response: 'scheduleCancel time must be a number (unix ms)' }, 400);
        }
        const scResult = await scheduleCancel(effectiveWallet, action.time);
        if ('error' in scResult) {
          return c.json({ status: 'err', response: scResult.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── usdClassTransfer ─────────────────────────────────────────────────

      case 'usdClassTransfer': {
        if (typeof action.amount !== 'string' || typeof action.toPerp !== 'boolean') {
          return c.json({ status: 'err', response: 'usdClassTransfer requires amount (string) and toPerp (boolean)' }, 400);
        }
        const result = await usdClassTransfer(effectiveWallet, action.amount, action.toPerp);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── usdSend ──────────────────────────────────────────────────────────

      case 'usdSend': {
        if (typeof action.destination !== 'string' || typeof action.amount !== 'string') {
          return c.json({ status: 'err', response: 'usdSend requires destination (string) and amount (string)' }, 400);
        }
        const result = await usdSend(effectiveWallet, action.destination, action.amount);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── spotSend ─────────────────────────────────────────────────────────

      case 'spotSend': {
        if (typeof action.destination !== 'string' ||
            typeof action.token !== 'string' ||
            typeof action.amount !== 'string') {
          return c.json({ status: 'err', response: 'spotSend requires destination, token, amount (all strings)' }, 400);
        }
        const result = await spotSend(effectiveWallet, action.destination, action.token, action.amount);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── sendAsset ────────────────────────────────────────────────────────

      case 'sendAsset': {
        if (typeof action.destination !== 'string' ||
            typeof action.token !== 'string' ||
            typeof action.amount !== 'string') {
          return c.json({ status: 'err', response: 'sendAsset requires destination, token, amount' }, 400);
        }
        const result = await sendAsset(
          effectiveWallet,
          action.destination,
          (action as any).sourceDex      ?? '',
          (action as any).destinationDex ?? '',
          action.token,
          action.amount,
          (action as any).fromSubAccount ?? '',
        );
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── agentSendAsset ───────────────────────────────────────────────────

      case 'agentSendAsset': {
        if (typeof action.destination !== 'string' ||
            typeof action.token !== 'string' ||
            typeof action.amount !== 'string') {
          return c.json({ status: 'err', response: 'agentSendAsset requires destination, token, amount' }, 400);
        }
        const result = await agentSendAsset(
          effectiveWallet,
          action.destination,
          (action as any).sourceDex      ?? '',
          (action as any).destinationDex ?? '',
          action.token,
          action.amount,
          (action as any).fromSubAccount ?? '',
        );
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── sendToEvmWithData ────────────────────────────────────────────────

      case 'sendToEvmWithData': {
        if (typeof action.token !== 'string' || typeof action.amount !== 'string') {
          return c.json({ status: 'err', response: 'sendToEvmWithData requires token and amount' }, 400);
        }
        const result = await sendToEvmWithData(
          effectiveWallet,
          action.token,
          action.amount,
          (action as any).sourceDex            ?? '',
          (action as any).destinationRecipient ?? '',
          (action as any).destinationChainId   ?? 0,
          (action as any).gasLimit             ?? 0,
          (action as any).data                 ?? '0x',
        );
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── createSubAccount ─────────────────────────────────────────────────

      case 'createSubAccount': {
        if (typeof action.name !== 'string' || !action.name.trim()) {
          return c.json({ status: 'err', response: 'createSubAccount requires a non-empty name' }, 400);
        }
        const result = await createSubAccount(wallet, action.name);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── subAccountTransfer ───────────────────────────────────────────────

      case 'subAccountTransfer': {
        if (typeof action.subAccountUser !== 'string' ||
            typeof action.isDeposit !== 'boolean' ||
            typeof action.usd !== 'number') {
          return c.json({ status: 'err', response: 'subAccountTransfer requires subAccountUser, isDeposit, usd' }, 400);
        }
        const result = await subAccountTransfer(wallet, action.subAccountUser, action.isDeposit, action.usd);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── subAccountSpotTransfer ───────────────────────────────────────────

      case 'subAccountSpotTransfer': {
        if (typeof action.subAccountUser !== 'string' ||
            typeof action.isDeposit !== 'boolean' ||
            typeof action.token !== 'string' ||
            typeof action.amount !== 'string') {
          return c.json({ status: 'err', response: 'subAccountSpotTransfer requires subAccountUser, isDeposit, token, amount' }, 400);
        }
        const result = await subAccountSpotTransfer(wallet, action.subAccountUser, action.isDeposit, action.token, action.amount);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── vaultTransfer ────────────────────────────────────────────────────

      case 'vaultTransfer': {
        if (typeof action.vaultAddress !== 'string' ||
            typeof action.isDeposit !== 'boolean' ||
            typeof action.usd !== 'number') {
          return c.json({ status: 'err', response: 'vaultTransfer requires vaultAddress, isDeposit, usd' }, 400);
        }
        const result = await vaultTransfer(effectiveWallet, action.vaultAddress, action.isDeposit, action.usd);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── approveAgent ─────────────────────────────────────────────────────
      // Authorize an API wallet to sign transactions on behalf of this account.
      // Confirmed shape from docs: { type, signatureChainId, hyperliquidChain,
      //   agentAddress, agentName (optional), nonce }
      // agentName omitted or empty = unnamed agent (max 1)
      // agentName present = named agent (max 10, same name replaces previous)
      // agentAddress = zero address = revoke that agent
      // Success response: { status: "ok", response: { type: "default" } }

      case 'approveAgent': {
        if (typeof action.agentAddress !== 'string') {
          return c.json({ status: 'err', response: 'approveAgent requires agentAddress (string)' }, 400);
        }
        const result = await approveAgent(
          wallet,
          action.agentAddress,
          (action as any).agentName,
        );
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── approveBuilderFee ────────────────────────────────────────────────
      // Set max fee rate for a builder address.
      // Confirmed shape from Python SDK: { type, maxFeeRate, builder, nonce }
      // maxFeeRate format: "0.001%" (basis points as percentage string)
      // Must be signed by master wallet, not an agent wallet.
      // Success response: { status: "ok", response: { type: "default" } }

      case 'approveBuilderFee': {
        if (typeof action.builder !== 'string' || typeof action.maxFeeRate !== 'string') {
          return c.json({ status: 'err', response: 'approveBuilderFee requires builder (string) and maxFeeRate (string)' }, 400);
        }
        // Must be signed by master wallet, not sub-account proxy
        const result = await approveBuilderFee(wallet, action.builder, action.maxFeeRate);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── setReferrer ──────────────────────────────────────────────────────
      // Record a referral code for this user.
      // Confirmed shape from SDK: { type, code }
      // `code` is the referral code string (alphanumeric, up to ~20 chars).
      // Success response: { status: "ok", response: { type: "default" } }

      case 'setReferrer': {
        if (typeof action.code !== 'string' || !action.code.trim()) {
          return c.json({ status: 'err', response: 'setReferrer requires code (non-empty string)' }, 400);
        }
        const result = await setReferrer(wallet, action.code);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── cDeposit ─────────────────────────────────────────────────────────
      // Move HYPE from spot balance into the staking account.
      // Confirmed shape from Go SDK: { type, wei }
      // `wei` is the amount in HL wei units (1 HYPE = 1e8 = 100_000_000 wei).
      // Success response: { status: "ok", response: { type: "default" } }

      case 'cDeposit': {
        if (typeof action.wei !== 'number') {
          return c.json({ status: 'err', response: 'cDeposit requires wei (number)' }, 400);
        }
        const result = await cDeposit(wallet, action.wei);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── cWithdraw ────────────────────────────────────────────────────────
      // Initiate 7-day unstake queue.
      // HYPE is deducted from staking balance immediately and placed in a
      // time-locked queue. The StakingWorker completes the withdrawal after 7d.
      // Confirmed shape from Go SDK: { type, wei }
      // Success response: { status: "ok", response: { type: "default" } }

      case 'cWithdraw': {
        if (typeof action.wei !== 'number') {
          return c.json({ status: 'err', response: 'cWithdraw requires wei (number)' }, 400);
        }
        const result = await cWithdraw(wallet, action.wei);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── tokenDelegate ────────────────────────────────────────────────────
      // Delegate or undelegate staked HYPE to/from a validator.
      // 1-day lockup: cannot undelegate within 1 day of delegating.
      // Confirmed shape from Go SDK: { type, validator, wei, isUndelegate }
      // `validator`: validator wallet address
      // `wei`: amount in HL wei (1 HYPE = 1e8 wei)
      // `isUndelegate`: false = delegate, true = undelegate
      // Success response: { status: "ok", response: { type: "default" } }

      case 'tokenDelegate': {
        if (typeof action.validator !== 'string' ||
            typeof action.wei !== 'number' ||
            typeof action.isUndelegate !== 'boolean') {
          return c.json({
            status: 'err',
            response: 'tokenDelegate requires validator (string), wei (number), isUndelegate (boolean)',
          }, 400);
        }
        const result = await tokenDelegate(wallet, action.validator, action.wei, action.isUndelegate);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── topUpIsolatedOnlyMargin ──────────────────────────────────────────
      // Adds margin to an isolated position with no withdrawal path. Routes
      // into the same rawUsd field as updateIsolatedMargin — liquidationPx is
      // recomputed on read (position.ts) so no explicit recompute is needed.
      // HyPaper doesn't track the "isolated-only" lock separately because
      // paper mode has no withdrawal action to enforce against.

      case 'topUpIsolatedOnlyMargin': {
        if (typeof action.asset !== 'number' || typeof action.ntli !== 'number') {
          return c.json({ status: 'err', response: 'topUpIsolatedOnlyMargin requires asset and ntli' }, 400);
        }
        const result = await updateIsolatedMargin(effectiveWallet, action.asset, true, action.ntli);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── reserveRequestWeight ─────────────────────────────────────────────
      // Real HL pre-deducts request weight from the account's per-second
      // budget. HyPaper has no rate-limit budget, so we validate shape and
      // acknowledge. Returns the same { type: 'default' } envelope so clients
      // that key off success status keep working.

      case 'reserveRequestWeight': {
        if (typeof action.weight !== 'number' || !Number.isFinite(action.weight) || action.weight < 0) {
          return c.json({ status: 'err', response: 'reserveRequestWeight requires weight: positive number' }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── noop ─────────────────────────────────────────────────────────────
      // Explicit do-nothing. Used by some clients as a keepalive or to
      // advance the nonce window. HyPaper acknowledges.

      case 'noop': {
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── default ──────────────────────────────────────────────────────────

      default: {
        return c.json({
          status: 'err',
          response: `Unsupported action type: ${(action as { type: string }).type}`,
        }, 400);
      }
    }
  } catch (err) {
    logger.error({ err, action: action.type }, 'Exchange error');
    return c.json({ status: 'err', response: String(err) }, 500);
  }
});