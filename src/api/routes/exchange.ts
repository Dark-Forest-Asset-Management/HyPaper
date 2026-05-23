import { Hono } from 'hono';
import { placeOrders, cancelOrders, cancelByCloid, updateLeverage, modifyOrder, batchModifyOrders, createTwapOrder, cancelTwapOrder } from '../../engine/order.js';
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
  const hasLimit = !!o.t?.limit?.tif;
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
  const size = Number(o.s);
  const price = Number(o.p);
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
    return 'Size and price must be finite positive numbers';
  }
  return null;
}

exchangeRouter.post('/', async (c) => {
  const body = await c.req.json();

  // Derive the wallet from the signature (HL-prod shape: no `wallet`
  // field in the body — slushy uses this for both paper and live so the
  // exchange POST is identical across modes). Fall back to `body.wallet`
  // only when no signature is present (unsigned local tests, scripts).
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

  // Vault address is a real HL feature where the order executes against the
  // vault's collateral instead of the signer's. HyPaper doesn't simulate
  // vaults, so we reject explicitly rather than silently swap the wallet.
  if (body.vaultAddress) {
    return c.json({ status: 'err', response: 'vaultAddress is not supported by HyPaper paper-trading' }, 400);
  }

  // Replay protection: track the highest nonce we've seen per wallet and
  // reject anything ≤ that. HL uses unix-ms nonces; clients are expected
  // to monotonically increase. We only enforce when a `nonce` is present
  // so unsigned local calls (e.g., from tests) still work.
  if (typeof body.nonce === 'number' && Number.isFinite(body.nonce)) {
    const prevStr = await redis.get(KEYS.USER_NONCE_MAX(wallet));
    const prev = prevStr ? parseInt(prevStr, 10) : 0;
    if (body.nonce <= prev) {
      return c.json({ status: 'err', response: `Nonce ${body.nonce} ≤ previous ${prev} (replay)` }, 400);
    }
    await redis.set(KEYS.USER_NONCE_MAX(wallet), String(body.nonce));
  }

  // expiresAfter — when present, every order placed by this action gets
  // tagged with the deadline. The matcher sweeps expired orders on each
  // tick. Optional, ignored if missing.
  const expiresAfter = typeof body.expiresAfter === 'number' && Number.isFinite(body.expiresAfter)
    ? body.expiresAfter
    : undefined;

  const action: HlExchangeAction = body.action;
  if (!action || typeof action !== 'object' || !action.type) {
    return c.json({ status: 'err', response: 'Missing or invalid action' }, 400);
  }

  try {
    switch (action.type) {
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
        return c.json({
          status: 'ok',
          response: {
            type: 'order',
            data: { statuses },
          },
        });
      }

      case 'modify': {
        if (typeof action.oid !== 'number' && typeof action.oid !== 'string') {
          return c.json({ status: 'err', response: 'modify requires oid (number or cloid string)' }, 400);
        }
        if (typeof action.oid === 'string' && !CLOID_RE.test(action.oid)) {
          return c.json({ status: 'err', response: 'modify oid (cloid) must be 0x-prefixed 16-byte hex' }, 400);
        }
        const wireErr = validateOrderWire(action.order);
        if (wireErr) return c.json({ status: 'err', response: wireErr }, 400);

        const result = await modifyOrder(wallet, action.oid, action.order);
        // HL returns `{ type: 'default' }` for modify regardless of fill
        // status — surface the underlying place result on errors only.
        if (typeof result === 'object' && result !== null && 'error' in result) {
          return c.json({ status: 'err', response: (result as { error: string }).error }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

      case 'batchModify': {
        if (!Array.isArray(action.modifies) || action.modifies.length === 0) {
          return c.json({ status: 'err', response: 'Missing modifies array' }, 400);
        }
        for (const m of action.modifies) {
          if ((typeof m.oid !== 'number' && typeof m.oid !== 'string') ||
              (typeof m.oid === 'string' && !CLOID_RE.test(m.oid))) {
            return c.json({ status: 'err', response: 'Each modify needs valid oid' }, 400);
          }
          const err = validateOrderWire(m.order);
          if (err) return c.json({ status: 'err', response: err }, 400);
        }
        await batchModifyOrders(wallet, action.modifies);
        return c.json({ status: 'ok', response: { type: 'default' } });
      }

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
        return c.json({
          status: 'ok',
          response: {
            type: 'cancel',
            data: { statuses },
          },
        });
      }

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
        return c.json({
          status: 'ok',
          response: {
            type: 'cancel',
            data: { statuses },
          },
        });
      }

      case 'twapOrder': {
        const tw = action.twap;
        if (
          typeof tw?.a !== 'number' || typeof tw?.b !== 'boolean' ||
          typeof tw?.s !== 'string' || typeof tw?.r !== 'boolean' ||
          typeof tw?.m !== 'number' || typeof tw?.t !== 'boolean'
        ) {
          return c.json({ status: 'err', response: 'twapOrder requires twap.{a,b,s,r,m,t}' }, 400);
        }
        if (tw.m < 5) {
          return c.json({ status: 'err', response: 'TWAP duration minimum is 5 minutes' }, 400);
        }
        const twapResult = await createTwapOrder(wallet, tw.a, tw.b, tw.s, tw.r, tw.m);
        if ('error' in twapResult) {
          return c.json({ status: 'ok', response: { type: 'twapOrder', data: { status: { error: twapResult.error } } } });
        }
        return c.json({
          status: 'ok',
          response: { type: 'twapOrder', data: { status: { running: { twapId: twapResult.twapId } } } },
        });
      }

      case 'twapCancel': {
        if (typeof action.a !== 'number' || typeof action.t !== 'number') {
          return c.json({ status: 'err', response: 'twapCancel requires a (asset) and t (twapId)' }, 400);
        }
        const cancelResult = await cancelTwapOrder(wallet, action.t);
        if ('error' in cancelResult) {
          return c.json({ status: 'err', response: cancelResult.error }, 400);
        }
        return c.json({
          status: 'ok',
          response: { type: 'twapCancel', data: { status: 'success' } },
        });
      }
      case 'updateLeverage': {
        if (typeof action.asset !== 'number' || typeof action.leverage !== 'number' || typeof action.isCross !== 'boolean') {
          return c.json({ status: 'err', response: 'updateLeverage requires asset (number), leverage (number), isCross (boolean)' }, 400);
        }
        if (action.leverage < 1 || action.leverage > 200) {
          return c.json({ status: 'err', response: 'Leverage must be between 1 and 200' }, 400);
        }

        await updateLeverage(wallet, action.asset, action.isCross, action.leverage);
        return c.json({
          status: 'ok',
          response: { type: 'default' },
        });
      }

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
