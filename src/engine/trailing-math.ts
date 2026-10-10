/**
 * Trailing-stop wire format, math and HL-exact output builders. PURE module —
 * no redis, no event bus, no worker imports — so it can be used by the
 * matcher, the info builders, the route and the tests alike without any
 * import cycle.
 *
 * Ground truth: HL TESTNET probes (scripts/probe-hl-testnet-trailing-stop*.ts,
 * captures scripts/captures/30_* … 34_*, write-up in
 * scripts/captures/trailing-stop-summary.md). Every rule below that is not
 * directly observed is marked `UNCONFIRMED` and listed in
 * trailing-stop-implementation-plan.md ("Assumptions").
 *
 * Wire shape (separate action type, NOT inside `order`):
 *   { type:'trailingStop', asset, isBuy, sz, reduceOnly,
 *     retracement:{px}|{pct}, activationPx:null|string }
 * msgpack field order is signature-critical (verified by offline signer
 * recovery against real UI captures): type, asset, isBuy, sz, reduceOnly,
 * retracement, activationPx.
 */

import DecimalModule from 'decimal.js';
import { D } from '../utils/math.js';

const Decimal = DecimalModule.default ?? DecimalModule;
type Dec = InstanceType<typeof Decimal>;

// ─── Wire format ──────────────────────────────────────────────────────────────

/** Order the keys MUST be msgpack-encoded in for the signature to recover the real signer. */
export const TRAILING_KEY_ORDER = [
  'type', 'asset', 'isBuy', 'sz', 'reduceOnly', 'retracement', 'activationPx',
] as const;

export interface TrailingStopWire {
  type: 'trailingStop';
  asset: number;
  isBuy: boolean;
  sz: string;
  reduceOnly: boolean;
  retracement: { px: string } | { pct: string };
  activationPx: string | null;
}

/** HL's generic body-deserialization failure text. UNCONFIRMED (recalled, not captured). */
export const ERR_DESERIALIZE = 'Failed to deserialize the JSON body into the target type';
/** Captured from HL testnet (30_trailing_invalid_pct_zero). */
export const ERR_RETRACEMENT_INVALID = 'Trailing stop retracement is invalid.';
/** Captured from HL testnet (30_trailing_invalid_px_zero). */
export const ERR_PRICE_CONVERT = 'Error converting float to price';
/** Captured (round 6): a pct string that is malformed or not a multiple of 0.001 %. */
export const ERR_PERCENTAGE_INVALID = 'Percentage is invalid.';
/** Captured (round 6): modify / batchModify aimed at a trailing stop. */
export const ERR_MODIFY_INVALID = 'Attempted to modify to invalid new order';
/** Captured (round 6): expiresAfter already in the past (HTTP 200, status "err"). */
export const ERR_ACTION_EXPIRED = 'Action already expired';
/** Captured from HL testnet (33_orphan_o1_explicit_cancel) — cancel of a finished/absent order. */
export const ERR_ALREADY_FINISHED = (asset: number) =>
  `Order was never placed, already canceled, or filled. asset=${asset}`;

const DEC_RE = /^\d+(\.\d+)?$/;
const PCT_RE = /^\d+(\.\d+)?%$/;

export type ParseResult =
  | { ok: true; action: TrailingStopWire }
  | { ok: false; error: string };

/**
 * Rebuild a raw `trailingStop` action in the canonical msgpack key order and
 * validate its SHAPE (not its semantics). Done BEFORE signature recovery:
 * HyPaper msgpack-encodes the action in JSON arrival order, and HL's own web
 * UI shows (and a client may send) key-SORTED JSON — recovering a signer from
 * that order yields a phantom wallet. Extra / missing / wrongly-typed fields
 * are rejected rather than guessed at.
 */
export function canonicalizeTrailingStop(raw: unknown): ParseResult {
  const bad: ParseResult = { ok: false, error: ERR_DESERIALIZE };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad;
  const a = raw as Record<string, unknown>;

  const keys = Object.keys(a);
  if (keys.length !== TRAILING_KEY_ORDER.length) return bad;
  for (const k of TRAILING_KEY_ORDER) if (!(k in a)) return bad;

  if (a.type !== 'trailingStop') return bad;
  if (typeof a.asset !== 'number' || !Number.isInteger(a.asset) || a.asset < 0) return bad;
  if (typeof a.isBuy !== 'boolean') return bad;
  if (typeof a.sz !== 'string') return bad;
  if (typeof a.reduceOnly !== 'boolean') return bad;

  const r = a.retracement;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return bad;
  const rKeys = Object.keys(r as object);
  if (rKeys.length !== 1) return bad;
  let retracement: { px: string } | { pct: string };
  if (rKeys[0] === 'px') {
    const v = (r as { px: unknown }).px;
    if (typeof v !== 'string') return bad;
    retracement = { px: v };
  } else if (rKeys[0] === 'pct') {
    const v = (r as { pct: unknown }).pct;
    if (typeof v !== 'string') return bad;
    retracement = { pct: v };
  } else {
    return bad;
  }

  const act = a.activationPx;
  if (act !== null && typeof act !== 'string') return bad;

  // Fresh object, keys inserted in the exact signing order.
  return {
    ok: true,
    action: {
      type: 'trailingStop',
      asset: a.asset,
      isBuy: a.isBuy,
      sz: a.sz,
      reduceOnly: a.reduceOnly,
      retracement,
      activationPx: act as string | null,
    },
  };
}

/** Parse a plain non-negative decimal string; null if it is not one. */
function parseDec(s: string): Dec | null {
  return DEC_RE.test(s) ? D(s) : null;
}

/**
 * Round a price-like distance DOWN to the coin's price decimals (6 − szDecimals).
 * HL normalises px this way: ETH (2 decimals) px 0.123 became 0.12; BTC (1 decimal) px 0.05 became 0
 * and was rejected. Truncation (not half-up) is the only mode consistent with both; truncate vs
 * half-even was not distinguished.
 */
export function normalizePx(px: string, szDecimals: number): Dec {
  return D(px).toDecimalPlaces(priceDecimals(szDecimals), Decimal.ROUND_DOWN);
}

/**
 * Semantic validation of a canonical action, with HL's messages (round 4 + round 6 captures):
 *  - pct: must look like `<digits>[.<digits>]%` and be a multiple of 0.001 % → else "Percentage is invalid.";
 *         0 or >= 100 → "Trailing stop retracement is invalid."
 *  - px:  not a number, or 0 after normalisation to the coin's price decimals → "Error converting float to price"
 *  - activationPx: not a positive number → "Error converting float to price"  (message UNCONFIRMED)
 * The px upper bound (needs a reference price) is validated in placement, see validatePxAgainstReference.
 */
export function validateTrailingStop(a: TrailingStopWire, szDecimals: number): string | null {
  const sz = parseDec(a.sz);
  if (!sz || sz.lte(0)) return `Invalid order size: ${a.sz}`;

  if ('pct' in a.retracement) {
    const raw = a.retracement.pct;
    if (!PCT_RE.test(raw)) return ERR_PERCENTAGE_INVALID;
    const v = D(raw.slice(0, -1));
    if (!v.times(1000).isInteger()) return ERR_PERCENTAGE_INVALID;   // granularity 0.001 %
    if (v.lte(0) || v.gte(100)) return ERR_RETRACEMENT_INVALID;
  } else {
    const px = parseDec(a.retracement.px);
    if (!px || normalizePx(a.retracement.px, szDecimals).lte(0)) return ERR_PRICE_CONVERT;
  }

  if (a.activationPx !== null) {
    const act = parseDec(a.activationPx);
    if (!act || act.lte(0)) return ERR_PRICE_CONVERT;
  }
  return null;
}

/**
 * A fixed-distance SELL stop whose distance is at/above its reference price can never hold a positive
 * trigger: HL answers "Trailing stop retracement is invalid." (px 100000 / 1000000 / 99999999 on BTC ≈ 81k).
 * Reference = activationPx while waiting, else the current mark. The exact threshold and the BUY side
 * were not probed — only sells are rejected here (assumption).
 */
export function validatePxAgainstReference(p: TrailingParams, mark: string): string | null {
  if (p.kind !== 'px' || p.isBuy) return null;
  const ref = p.activationPx ?? mark;
  return D(p.value).gte(ref) ? ERR_RETRACEMENT_INVALID : null;
}

// ─── Persisted parameters / state ────────────────────────────────────────────

export interface TrailingParams {
  isBuy: boolean;
  /** 'px' = fixed distance, 'pct' = percent. `value` is a Decimal-normalised number string WITHOUT the % sign. */
  kind: 'px' | 'pct';
  value: string;
  activationPx: string | null;
  szDecimals: number;
}

export interface TrailingState {
  activated: boolean;
  /** Best (watermark) mark seen since activation; null while waiting. */
  best: string | null;
}

export function paramsFromWire(a: TrailingStopWire, szDecimals: number): TrailingParams {
  const kind = 'pct' in a.retracement ? 'pct' : 'px';
  const value =
    'pct' in a.retracement
      ? D(a.retracement.pct.slice(0, -1)).toFixed()
      : normalizePx(a.retracement.px, szDecimals).toFixed(); // ETH px 0.123 → 0.12 (HL echoes the normalised value)
  return {
    isBuy: a.isBuy,
    kind,
    value,
    activationPx: a.activationPx === null ? null : D(a.activationPx).toFixed(),
    szDecimals,
  };
}

// ─── Math ─────────────────────────────────────────────────────────────────────

/** Price decimals for a perp: 6 − szDecimals (HL's MAX_DECIMALS rule). 1 dp for BTC (szDecimals 5). */
export function priceDecimals(szDecimals: number): number {
  return Math.max(0, 6 - szDecimals);
}

/**
 * Trigger price for a given watermark:
 *   sell: best − distance            | best × (1 − pct/100)
 *   buy : best + distance            | best × (1 + pct/100)
 * rounded HALF-UP to {@link priceDecimals} (e.g. 83563 × 0.95 = 79384.85 → 79384.9;
 * validated on 49/49 captured BTC rows. Other coins: UNCONFIRMED).
 */
export function computeTrigger(p: TrailingParams, best: string): Dec {
  const b = D(best);
  const v = D(p.value);
  let raw: Dec;
  if (p.kind === 'px') {
    raw = p.isBuy ? b.plus(v) : b.minus(v);
  } else {
    const rate = v.div(100);
    raw = p.isBuy ? b.times(D(1).plus(rate)) : b.times(D(1).minus(rate));
  }
  return raw.toDecimalPlaces(priceDecimals(p.szDecimals), Decimal.ROUND_HALF_UP);
}

/**
 * The 10 % market-order cap HL reports as `limitPx` (it moves with every
 * ratchet, and before activation tracks the activation price):
 *   sell: floor(trigger × 0.9) + 1 step   buy: floor(trigger × 1.1)
 * where step is 1 for BTC. Reproduced on 49/49 captured BTC rows; the `+1`
 * on sells is a fit (72972.0 → 72973 observed), not a known formula.
 * Other coins use HL's price rule (≤5 significant figures, ≤ 6−szDecimals
 * decimals) for the step — UNCONFIRMED.
 */
export function computeLimit(p: TrailingParams, trigger: Dec): string {
  const raw = trigger.times(p.isBuy ? '1.1' : '0.9');
  const intDigits = Math.max(1, raw.abs().floor().toFixed().replace('-', '').length);
  const k = Math.min(priceDecimals(p.szDecimals), Math.max(0, 5 - intDigits));
  const step = new Decimal(10).pow(-k);
  const floored = raw.div(step).floor().times(step);
  return (p.isBuy ? floored : floored.plus(step)).toFixed();
}

export interface TrailingEval {
  state: TrailingState;
  /** Live trigger price (decimal string), null until activated. */
  triggerPx: string | null;
  /** Live limit/cap price (decimal string). */
  limitPx: string;
  /** True when this mark crosses the trigger (inclusive — UNCONFIRMED) and the stop must fire. */
  fire: boolean;
}

/**
 * One evaluation step on a MARK price.
 *  - not activated: activates when (sell) mark ≥ activationPx / (buy) mark ≤
 *    activationPx, or immediately when there is no activationPx. An activation
 *    already satisfied at placement activates at once (HL does NOT reject the
 *    "wrong side"; confirmed both sides). `best` is seeded with the mark.
 *  - activated: `best` only ratchets favourably (sell: up, buy: down).
 *  - fires when sell: mark ≤ trigger / buy: mark ≥ trigger.
 */
export function evaluateTrailing(p: TrailingParams, prev: TrailingState, mark: string): TrailingEval {
  let activated = prev.activated;
  let best = prev.best;

  if (!activated) {
    const m = D(mark);
    const reached =
      p.activationPx === null
        ? true
        : p.isBuy ? m.lte(p.activationPx) : m.gte(p.activationPx);
    if (reached) {
      activated = true;
      best = D(mark).toFixed();
    }
  } else {
    const m = D(mark);
    const b = D(best!);
    best = (p.isBuy ? Decimal.min(b, m) : Decimal.max(b, m)).toFixed();
  }

  if (!activated) {
    // Waiting. triggerPx is "0.0" but limitPx is still populated, computed from the
    // activation price as if it were the watermark (observed).
    const virtualTrigger = computeTrigger(p, p.activationPx!);
    return {
      state: { activated: false, best: null },
      triggerPx: null,
      limitPx: computeLimit(p, virtualTrigger),
      fire: false,
    };
  }

  const trigger = computeTrigger(p, best!);
  const fire = p.isBuy ? D(mark).gte(trigger) : D(mark).lte(trigger);
  return {
    state: { activated: true, best },
    triggerPx: trigger.toFixed(),
    limitPx: computeLimit(p, trigger),
    fire,
  };
}

// ─── Formatting (HL-exact) ───────────────────────────────────────────────────

/** Price string with at least one decimal, as HL prints them: "81056.0", "82710.7", "0.0". */
export function fmtPrice1(v: string | Dec): string {
  const s = D(v).toFixed();
  return s.includes('.') ? s : `${s}.0`;
}

/**
 * The prose HL puts in `triggerCondition` for a live trailing stop (49/49
 * captured strings reproduced):
 *   "Activation <immediate | above X | below X>, retracement <N | P%>, best <waiting | M>"
 * The activation word depends on the SIDE (sell → above, buy → below), never
 * on whether X is above or below the mark.
 */
export function triggerConditionText(p: TrailingParams, s: TrailingState): string {
  const act =
    p.activationPx === null
      ? 'immediate'
      : `${p.isBuy ? 'below' : 'above'} ${D(p.activationPx).toFixed()}`;
  const ret = p.kind === 'pct' ? `${D(p.value).toFixed()}%` : D(p.value).toFixed();
  const best = s.best === null ? 'waiting' : D(s.best).toFixed();
  return `Activation ${act}, retracement ${ret}, best ${best}`;
}

// ─── Redis-hash (de)serialisation helpers ────────────────────────────────────

/** Extra hash fields persisted for a trailing stop (all strings, like the rest of the order hash). */
export interface TrailingFields {
  trKind: 'px' | 'pct';
  trValue: string;
  trActPx: string;           // '' = none
  trActivated: 'true' | 'false';
  trBest: string;            // '' = waiting
  trSzDec: string;
}

export function fieldsFrom(p: TrailingParams, s: TrailingState): TrailingFields {
  return {
    trKind: p.kind,
    trValue: p.value,
    trActPx: p.activationPx ?? '',
    trActivated: s.activated ? 'true' : 'false',
    trBest: s.best ?? '',
    trSzDec: String(p.szDecimals),
  };
}

export function isTrailingHash(data: Record<string, string>): boolean {
  return data.orderType === 'trailingStop';
}

export function readTrailing(data: Record<string, string>): { params: TrailingParams; state: TrailingState } {
  return {
    params: {
      isBuy: data.isBuy === 'true',
      kind: data.trKind === 'pct' ? 'pct' : 'px',
      value: data.trValue,
      activationPx: data.trActPx ? data.trActPx : null,
      szDecimals: parseInt(data.trSzDec ?? '0', 10),
    },
    state: {
      activated: data.trActivated === 'true',
      best: data.trBest ? data.trBest : null,
    },
  };
}

// ─── HL-shaped bodies ────────────────────────────────────────────────────────

export interface TrailingBody {
  coin: string;
  side: 'A' | 'B';
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  triggerCondition: string;
  isTrigger: boolean;
  triggerPx: string;
  children: never[];
  isPositionTpsl: boolean;
  reduceOnly: boolean;
  orderType: 'Trailing Stop Market';
  origSz: string;
  tif: string | null;
  cloid: string | null;
}

/**
 * The order body as `frontendOpenOrders` / `orderStatus` / `historicalOrders`
 * carry it, built from a Redis order hash.
 *  - open:  live state (trigger text, triggerPx or "0.0" before activation,
 *           tif null, sz = original size, timestamp = placement time)
 *  - fired: sz "0.0", triggerCondition "Triggered", isTrigger false,
 *           triggerPx "0.0", tif "Gtc", timestamp = fill time (all observed)
 */
/**
 * `sz` of a FINISHED stop's body: the unfilled remainder. A margin-partial fire (0.0008 of 0.00516 BTC) keeps the
 * remainder (0.00436); a full fill and the reduce-only clamp (which records the whole stop size as filled) show "0.0".
 */
export function remainderSz(data: Record<string, string>): string {
  const rem = D(data.sz).minus(data.filledSz ?? '0');
  return rem.lte(0) ? '0.0' : rem.toFixed();
}

export function buildTrailingBody(data: Record<string, string>, finished: boolean): TrailingBody {
  const { params, state } = readTrailing(data);
  const oid = parseInt(data.oid, 10);
  const coin = data.coin;
  const side = (data.isBuy === 'true' ? 'B' : 'A') as 'A' | 'B';
  const limitPx = fmtPrice1(data.limitPx || '0');
  const reduceOnly = data.reduceOnly === 'true';
  // Keys are written in HL's exact order (a JSON.stringify on either backend is byte-identical).
  if (finished) {
    return {
      coin, side, limitPx,
      sz: remainderSz(data),
      oid,
      timestamp: parseInt(data.updatedAt, 10),
      triggerCondition: 'Triggered',
      isTrigger: false,
      triggerPx: '0.0',
      children: [],
      isPositionTpsl: false,
      reduceOnly,
      orderType: 'Trailing Stop Market',
      origSz: data.sz,
      tif: 'Gtc',
      cloid: null,
    };
  }
  return {
    coin, side, limitPx,
    sz: data.sz,
    oid,
    timestamp: parseInt(data.createdAt, 10),
    triggerCondition: triggerConditionText(params, state),
    isTrigger: true,
    triggerPx: state.activated && data.triggerPx ? fmtPrice1(data.triggerPx) : '0.0',
    children: [],
    isPositionTpsl: false,
    reduceOnly,
    orderType: 'Trailing Stop Market',
    origSz: data.sz,
    tif: null,
    cloid: null,
  };
}

/** Plain `openOrders` row — `reduceOnly` present only when true (as observed for trailing stops). */
export function buildTrailingOpenOrderRow(data: Record<string, string>) {
  const row: {
    coin: string; side: 'A' | 'B'; limitPx: string; sz: string; oid: number;
    timestamp: number; origSz: string; reduceOnly?: boolean;
  } = {
    coin: data.coin,
    side: data.isBuy === 'true' ? 'B' : 'A',
    limitPx: fmtPrice1(data.limitPx || '0'),
    sz: data.sz,
    oid: parseInt(data.oid, 10),
    timestamp: parseInt(data.createdAt, 10),
    origSz: data.sz,
  };
  if (data.reduceOnly === 'true') row.reduceOnly = true;
  return row;
}

/**
 * `orderStatus` response for a trailing stop.
 *  - open: HL serves a FROZEN snapshot (the body as of placement) that does not follow the
 *    ratchet — `liveMode` (env TRAILING_ORDERSTATUS_LIVE) switches to the live body instead.
 *  - filled: the final body (see buildTrailingBody(…, true)).
 *  - canceled / reduceOnlyCanceled / marginCanceled: the body frozen at that moment.
 * `statusTimestamp` is the status-change time (= placement time while open).
 */
export function buildTrailingOrderStatus(data: Record<string, string>, liveMode: boolean) {
  const status = data.status;
  let body: TrailingBody;
  if (status === 'filled') {
    body = buildTrailingBody(data, true);
  } else if (status === 'open') {
    body = liveMode || !data.trSnap ? buildTrailingBody(data, false) : (JSON.parse(data.trSnap) as TrailingBody);
  } else {
    body = data.trSnap ? (JSON.parse(data.trSnap) as TrailingBody) : buildTrailingBody(data, false);
  }
  return {
    status: 'order' as const,
    order: {
      order: body,
      status: status === 'cancelled' ? 'canceled' : status,
      statusTimestamp: parseInt(data.updatedAt, 10),
    },
  };
}
