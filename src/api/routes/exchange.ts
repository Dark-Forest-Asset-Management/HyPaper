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
import { ensureAccount } from '../middleware/auth.js';
import { recoverHlSigner } from '../middleware/recoverHlSigner.js';
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
      wallet = recoverHlSigner(body.action, body.nonce, body.signature, body.vaultAddress);
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

  // vaultAddress — HyPaper doesn't simulate vaults, so we reject explicitly
  // rather than silently ignoring the field (which would attribute vault
  // trades to the signer's paper account).
  if (body.vaultAddress) {
    return c.json({ status: 'err', response: 'vaultAddress is not supported by HyPaper paper-trading' }, 400);
  }

  // Replay protection — track the highest nonce seen per wallet and reject
  // anything ≤ that value. Only enforced when a numeric nonce is present
  // so unsigned local test calls still work.
  if (typeof body.nonce === 'number' && Number.isFinite(body.nonce)) {
    const prevStr = await redis.get(KEYS.USER_NONCE_MAX(wallet));
    const prev    = prevStr ? parseInt(prevStr, 10) : 0;
    if (body.nonce <= prev) {
      return c.json({ status: 'err', response: `Nonce ${body.nonce} ≤ previous ${prev} (replay)` }, 400);
    }
    await redis.set(KEYS.USER_NONCE_MAX(wallet), String(body.nonce));
  }

  // expiresAfter — optional unix-ms deadline after which the action is
  // rejected. For order actions we tag each order with this deadline so
  // the matcher can sweep expired resting orders.
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
        const statuses = await placeOrders(wallet, action.orders, action.grouping ?? 'na', { expiresAfter });
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
        const statuses = await cancelOrders(wallet, action.cancels);
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
        const statuses = await cancelByCloid(wallet, action.cancels);
        return c.json({ status: 'ok', response: { type: 'cancel', data: { statuses } } });
      }

      // ── modify ───────────────────────────────────────────────────────────

      case 'modify': {
        // oid can be a numeric OID or a cloid string (HL spec: Number | Cloid)
        if (typeof action.oid !== 'number' && typeof action.oid !== 'string') {
          return c.json({ status: 'err', response: 'modify requires oid (number or cloid string)' }, 400);
        }
        if (typeof action.oid === 'string' && !CLOID_RE.test(action.oid)) {
          return c.json({ status: 'err', response: 'modify cloid must be 0x-prefixed 16-byte hex' }, 400);
        }
        const wireErr = validateOrderWire(action.order);
        if (wireErr) return c.json({ status: 'err', response: wireErr }, 400);

        // Resolve cloid → numeric oid if necessary
        let numericOid: number;
        if (typeof action.oid === 'string') {
          const oidStr = await redis.hget(KEYS.USER_CLOIDS(wallet), action.oid);
          if (!oidStr) return c.json({ status: 'err', response: `cloid ${action.oid} not found` }, 400);
          numericOid = parseInt(oidStr, 10);
        } else {
          numericOid = action.oid;
        }

        const result = await modifyOrder(wallet, numericOid, action.order);
        if ('error' in result) {
          return c.json({ status: 'err', response: result.error }, 400);
        }
        // Confirmed from testnet capture 02_modify.json
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

        // Resolve any cloid oids to numeric oids before calling engine
        const resolved: Array<{ oid: number; order: HlOrderWire }> = [];
        for (const m of action.modifies) {
          let numericOid: number;
          if (typeof m.oid === 'string') {
            const oidStr = await redis.hget(KEYS.USER_CLOIDS(wallet), m.oid);
            if (!oidStr) {
              // Return per-item error rather than aborting the whole batch
              resolved.push({ oid: -1, order: m.order });
              continue;
            }
            numericOid = parseInt(oidStr, 10);
          } else {
            numericOid = m.oid;
          }
          resolved.push({ oid: numericOid, order: m.order });
        }

        const statuses = await batchModifyOrders(wallet, resolved);
        // Confirmed from testnet capture 03_batchModify.json
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
        const twapResult = await createTwapOrder(wallet, t.a, t.b, t.s, t.r, t.m);
        if ('error' in twapResult) {
          // HL wraps even errors in status:ok for twapOrder (confirmed from testnet)
          return c.json({ status: 'ok', response: { type: 'twapOrder', data: { status: { error: twapResult.error } } } });
        }
        // Confirmed from testnet capture 04_twapOrder.json
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
        const cancelResult = await cancelTwapOrder(wallet, action.t);
        if ('error' in cancelResult) {
          return c.json({ status: 'err', response: cancelResult.error }, 400);
        }
        // Confirmed from testnet capture 05_twapCancel.json
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
        await updateLeverage(wallet, action.asset, action.isCross, action.leverage);
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── updateIsolatedMargin ─────────────────────────────────────────────

      case 'updateIsolatedMargin': {
        if (typeof action.asset !== 'number' || typeof action.isBuy !== 'boolean' ||
            typeof action.ntli !== 'number') {
          return c.json({ status: 'err', response: 'updateIsolatedMargin requires asset, isBuy, ntli' }, 400);
        }
        const marginResult = await updateIsolatedMargin(wallet, action.asset, action.isBuy, action.ntli);
        if ('error' in marginResult) {
          return c.json({ status: 'err', response: marginResult.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── scheduleCancel ───────────────────────────────────────────────────

      case 'scheduleCancel': {
        // `time` is optional — omitting it removes any previously scheduled cancel
        if (action.time !== undefined && typeof action.time !== 'number') {
          return c.json({ status: 'err', response: 'scheduleCancel time must be a number (unix ms)' }, 400);
        }
        const scResult = await scheduleCancel(wallet, action.time);
        if ('error' in scResult) {
          return c.json({ status: 'err', response: scResult.error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── usdClassTransfer ─────────────────────────────────────────────────
      // Transfer between spot and perp balances. HyPaper simulates a single
      // perp account with no spot balance, so we acknowledge the request
      // with the correct shape but don't move any funds.

      case 'usdClassTransfer': {
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      // ── Sub-accounts & vaults ────────────────────────────────────────────
      // HyPaper doesn't simulate sub-accounts or vaults. We acknowledge
      // these actions with the correct response shape rather than returning
      // an unsupported-action error, so client code that sends them doesn't
      // break in paper mode.

      case 'createSubAccount':
      case 'subAccountTransfer':
      case 'subAccountSpotTransfer':
      case 'vaultTransfer': {
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