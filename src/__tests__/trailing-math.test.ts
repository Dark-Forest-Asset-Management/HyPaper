import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeTrailingStop, validateTrailingStop, validatePxAgainstReference, normalizePx, remainderSz,
  paramsFromWire, evaluateTrailing,
  computeTrigger, computeLimit, fmtPrice1, triggerConditionText,
  buildTrailingBody, buildTrailingOpenOrderRow, fieldsFrom, readTrailing,
  ERR_DESERIALIZE, ERR_RETRACEMENT_INVALID, ERR_PRICE_CONVERT, ERR_PERCENTAGE_INVALID, TRAILING_KEY_ORDER,
  type TrailingParams, type TrailingStopWire,
} from '../engine/trailing-math.js';

const here = dirname(fileURLToPath(import.meta.url));
const captured = JSON.parse(
  readFileSync(resolve(here, 'fixtures/trailing/captured-frontend-rows.json'), 'utf8'),
).rows as Array<{ coin: string; szDecimals: number; side: 'A' | 'B'; triggerCondition: string; triggerPx: string; limitPx: string; reduceOnly: boolean }>;

const SZ_DEC = 5; // BTC on testnet

/** Recover params/state from HL's own prose so we can re-derive everything and compare. */
function fromProse(row: typeof captured[number]) {
  const m = /^Activation (immediate|above|below)(?: ([0-9.]+))?, retracement ([0-9.]+)(%?), best (waiting|[0-9.]+)$/.exec(row.triggerCondition);
  if (!m) throw new Error(`unparseable captured string: ${row.triggerCondition}`);
  const params: TrailingParams = {
    isBuy: row.side === 'B',
    kind: m[4] === '%' ? 'pct' : 'px',
    value: m[3],
    activationPx: m[2] ?? null,
    szDecimals: row.szDecimals,
  };
  const state = { activated: m[5] !== 'waiting', best: m[5] === 'waiting' ? null : m[5] };
  return { params, state };
}

describe('captured HL rows are reproduced byte-for-byte', () => {
  it('has real fixture coverage (both sides, px + pct, waiting + active)', () => {
    expect(captured.length).toBeGreaterThanOrEqual(100);
    // not just BTC: the rules must hold for other price decimals too (SOL 2, ETH 4)
    expect(new Set(captured.map((r) => r.coin))).toEqual(new Set(['BTC', 'ETH', 'SOL']));
    expect(captured.some((r) => r.side === 'A')).toBe(true);
    expect(captured.some((r) => r.side === 'B')).toBe(true);
    expect(captured.some((r) => r.triggerCondition.includes('%'))).toBe(true);
    expect(captured.some((r) => r.triggerCondition.endsWith('waiting'))).toBe(true);
    expect(captured.some((r) => r.triggerCondition.includes('immediate'))).toBe(true);
  });

  it.each(captured.map((r, i) => [i, r.triggerCondition, r] as const))(
    'row %i: %s',
    (_i, _text, row) => {
      const { params, state } = fromProse(row);
      // A mark that cannot flip state: for an active stop mark == best (no ratchet, never fires);
      // for a waiting stop, stay clear of the activation price on the non-activating side.
      const mark = state.activated
        ? state.best!
        : String(Number(params.activationPx) + (params.isBuy ? 100 : -100));
      const ev = evaluateTrailing(params, state, mark);

      expect(ev.state.activated).toBe(state.activated);
      expect(ev.fire).toBe(false);
      expect(ev.triggerPx === null ? '0.0' : fmtPrice1(ev.triggerPx)).toBe(row.triggerPx);
      expect(fmtPrice1(ev.limitPx)).toBe(row.limitPx);
      expect(triggerConditionText(params, ev.state)).toBe(row.triggerCondition);
    },
  );
});

describe('trigger / limit rules', () => {
  const sellPct: TrailingParams = { isBuy: false, kind: 'pct', value: '5', activationPx: null, szDecimals: SZ_DEC };

  it('rounds the trigger HALF-UP to 6-szDecimals decimals (83563 × 0.95 = 79384.85 → 79384.9)', () => {
    expect(computeTrigger(sellPct, '83563').toFixed()).toBe('79384.9');
  });

  it('limit: sell = floor(trigger×0.9)+1, buy = floor(trigger×1.1) (BTC)', () => {
    expect(computeLimit({ ...sellPct, kind: 'px', value: '2507' }, computeTrigger({ ...sellPct, kind: 'px', value: '2507' }, '83587'))).toBe('72973'); // 72972.0 → 73 (the +1)
    const buy: TrailingParams = { isBuy: true, kind: 'px', value: '2507', activationPx: null, szDecimals: SZ_DEC };
    expect(computeLimit(buy, computeTrigger(buy, '83559'))).toBe('94672'); // 86066 × 1.1 = 94672.6 → 94672
  });

  it('fmtPrice1 prints at least one decimal like HL', () => {
    expect(fmtPrice1('81056')).toBe('81056.0');
    expect(fmtPrice1('82710.7')).toBe('82710.7');
    expect(fmtPrice1('0')).toBe('0.0');
  });
});

describe('state machine on the MARK', () => {
  const sell: TrailingParams = { isBuy: false, kind: 'px', value: '5', activationPx: null, szDecimals: SZ_DEC };
  const buy: TrailingParams = { isBuy: true, kind: 'px', value: '5', activationPx: null, szDecimals: SZ_DEC };

  it('no activationPx → activates immediately, best seeded with the mark', () => {
    const ev = evaluateTrailing(sell, { activated: false, best: null }, '82760.2');
    expect(ev.state).toEqual({ activated: true, best: '82760.2' });
    expect(ev.triggerPx).toBe('82755.2');
    expect(ev.fire).toBe(false);
  });

  it('sell ratchets UP only; a dip keeps best and the trigger', () => {
    let s = evaluateTrailing(sell, { activated: false, best: null }, '82719').state;
    s = evaluateTrailing(sell, s, '82730').state;
    expect(s.best).toBe('82730');
    const dip = evaluateTrailing(sell, s, '82726');
    expect(dip.state.best).toBe('82730');
    expect(dip.triggerPx).toBe('82725');
    expect(dip.fire).toBe(false);
  });

  it('sell fires when mark <= trigger (inclusive)', () => {
    const s = { activated: true, best: '82730' };
    expect(evaluateTrailing(sell, s, '82725').fire).toBe(true);  // == trigger
    expect(evaluateTrailing(sell, s, '82725.1').fire).toBe(false);
    expect(evaluateTrailing(sell, s, '82700').fire).toBe(true);
  });

  it('buy ratchets DOWN only and fires when mark >= trigger', () => {
    let s = evaluateTrailing(buy, { activated: false, best: null }, '82831').state;
    s = evaluateTrailing(buy, s, '82822').state;
    expect(s.best).toBe('82822');
    expect(evaluateTrailing(buy, s, '82826').state.best).toBe('82822'); // rise: no change
    expect(evaluateTrailing(buy, s, '82826').fire).toBe(false);
    expect(evaluateTrailing(buy, s, '82827').fire).toBe(true);          // == 82822 + 5
  });

  it('sell activation: waits while mark < activationPx, activates at mark >= activationPx', () => {
    const p = { ...sell, activationPx: '82761' };
    const w = evaluateTrailing(p, { activated: false, best: null }, '82757');
    expect(w.state.activated).toBe(false);
    expect(w.triggerPx).toBeNull();           // "0.0" on the wire
    expect(w.fire).toBe(false);
    const a = evaluateTrailing(p, w.state, '82762');
    expect(a.state).toEqual({ activated: true, best: '82762' });
    expect(a.triggerPx).toBe('82757');
  });

  it('buy activation: activates at mark <= activationPx', () => {
    const p = { ...buy, activationPx: '81052' };
    expect(evaluateTrailing(p, { activated: false, best: null }, '82000').state.activated).toBe(false);
    expect(evaluateTrailing(p, { activated: false, best: null }, '81052').state.activated).toBe(true);
  });

  it('NO wrong-side rejection: activation already satisfied at placement → active at once (both sides)', () => {
    const sellWrong = { ...sell, value: '3000', activationPx: '82680' }; // below mark 82705
    const e1 = evaluateTrailing(sellWrong, { activated: false, best: null }, '82705');
    expect(e1.state).toEqual({ activated: true, best: '82705' });
    expect(e1.triggerPx).toBe('79705');
    const buyWrong = { ...buy, value: '3000', activationPx: '82856' };   // above mark 82831
    const e2 = evaluateTrailing(buyWrong, { activated: false, best: null }, '82831');
    expect(e2.state).toEqual({ activated: true, best: '82831' });
    expect(e2.triggerPx).toBe('85831');
  });

  it('percent form, tight 0.01 % (sell)', () => {
    const p: TrailingParams = { isBuy: false, kind: 'pct', value: '0.01', activationPx: null, szDecimals: SZ_DEC };
    const ev = evaluateTrailing(p, { activated: true, best: '82719' }, '82719');
    expect(ev.triggerPx).toBe('82710.7');   // 82710.7281 → 1 dp
  });
});

describe('triggerCondition prose', () => {
  it('uses the SIDE for the activation word, not the price relation', () => {
    const base = { kind: 'px', value: '3000', szDecimals: SZ_DEC } as const;
    expect(triggerConditionText({ ...base, isBuy: false, activationPx: '86066' }, { activated: false, best: null }))
      .toBe('Activation above 86066, retracement 3000, best waiting');
    expect(triggerConditionText({ ...base, isBuy: true, activationPx: '82856' }, { activated: true, best: '82831' }))
      .toBe('Activation below 82856, retracement 3000, best 82831');
  });

  it('normalises numbers like HL (5.0000 % → 5%, 0.0100 % → 0.01%, 82706.0 → 82706)', () => {
    const a = paramsFromWire({ type: 'trailingStop', asset: 3, isBuy: false, sz: '1', reduceOnly: true, retracement: { pct: '5.0000%' }, activationPx: null }, SZ_DEC);
    expect(triggerConditionText(a, { activated: true, best: '82706.0' })).toBe('Activation immediate, retracement 5%, best 82706');
    const b = paramsFromWire({ type: 'trailingStop', asset: 3, isBuy: false, sz: '1', reduceOnly: true, retracement: { pct: '0.0100%' }, activationPx: null }, SZ_DEC);
    expect(triggerConditionText(b, { activated: false, best: null })).toBe('Activation immediate, retracement 0.01%, best waiting');
  });
});

describe('wire canonicalisation (signature-critical)', () => {
  const sortedUi = {
    activationPx: null, asset: 3, isBuy: false, reduceOnly: true,
    retracement: { pct: '5.0000%' }, sz: '0.00014', type: 'trailingStop',
  };

  it('rebuilds key-SORTED JSON (what the HL UI shows/sends) into the msgpack signing order', () => {
    const r = canonicalizeTrailingStop(sortedUi);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.action)).toEqual([...TRAILING_KEY_ORDER]);
  });

  it('keeps activationPx as null (never dropped) and a single-key retracement', () => {
    const r = canonicalizeTrailingStop(sortedUi);
    if (!r.ok) throw new Error('unreachable');
    expect(r.action.activationPx).toBeNull();
    expect(Object.keys(r.action.retracement)).toEqual(['pct']);
  });

  it.each([
    ['missing key', (() => { const x: any = { ...sortedUi }; delete x.activationPx; return x; })()],
    ['extra key', { ...sortedUi, foo: 1 }],
    ['both px and pct', { ...sortedUi, retracement: { px: '5', pct: '5%' } }],
    ['px as number', { ...sortedUi, retracement: { px: 3000 } }],
    ['sz as number', { ...sortedUi, sz: 0.00014 }],
    ['activationPx as number', { ...sortedUi, activationPx: 86218 }],
    ['wrong type tag', { ...sortedUi, type: 'order' }],
    ['not an object', 'trailingStop'],
  ])('rejects malformed shape: %s', (_n, raw) => {
    expect(canonicalizeTrailingStop(raw)).toEqual({ ok: false, error: ERR_DESERIALIZE });
  });
});

describe('shape vs content: malformed STRING CONTENT is not a deserialize error', () => {
  const base = { activationPx: null, asset: 3, isBuy: false, reduceOnly: true, retracement: { pct: '5.0000%' }, sz: '0.00014', type: 'trailingStop' };
  it.each([
    ['pct without %', { ...base, retracement: { pct: '5.0000' } }],
    ['pct with leading space', { ...base, retracement: { pct: ' 5.0000%' } }],
    ['px non-numeric', { ...base, retracement: { px: 'abc' } }],
    ['activationPx non-numeric', { ...base, activationPx: 'abc' }],
  ])("%s passes the shape check (the semantic validator owns HL's message)", (_n, raw) => {
    expect(canonicalizeTrailingStop(raw).ok).toBe(true);
  });
});

describe('semantic validation — HL messages observed in rounds 4 and 6', () => {
  const ok = (over: Partial<TrailingStopWire> = {}): TrailingStopWire => ({
    type: 'trailingStop', asset: 3, isBuy: false, sz: '0.00015', reduceOnly: true,
    retracement: { px: '5' }, activationPx: null, ...over,
  });
  const pct = (v: string) => validateTrailingStop(ok({ retracement: { pct: v } }), SZ_DEC);
  const px = (v: string, dec = SZ_DEC) => validateTrailingStop(ok({ retracement: { px: v } }), dec);

  it('accepts every probed-good value: px 1 / 0.5 / 0.1, pct 1 / 0.1 / 0.01 / 0.001 %', () => {
    for (const v of ['1', '0.5', '0.1']) expect(px(v)).toBeNull();
    for (const v of ['1.0000%', '0.1000%', '0.0100%', '0.0010%']) expect(pct(v)).toBeNull();
    expect(validateTrailingStop(ok(), SZ_DEC)).toBeNull();
  });

  it.each(['5%', '5.0%', '5.00000%', '05.0000%', '5.0000%', '0.5000%'])('pct spelling %s is valid', (v) => {
    expect(pct(v)).toBeNull();
  });

  it.each(['5', '5.0000', '%5', ' 5.0000%', '5.0000% ', 'abc%', ''])('pct %j (malformed) → "Percentage is invalid."', (v) => {
    expect(pct(v)).toBe(ERR_PERCENTAGE_INVALID);
  });

  it.each(['0.0001%', '0.00001%', '0.000001%', '99.9999%', '1.2345%', '0.0015%'])('pct %s (not a multiple of 0.001 %) → "Percentage is invalid."', (v) => {
    expect(pct(v)).toBe(ERR_PERCENTAGE_INVALID);
  });

  it.each(['0.0000%', '0%', '100.0000%', '150.0000%', '100%'])('pct %s (zero / >= 100) → "Trailing stop retracement is invalid."', (v) => {
    expect(pct(v)).toBe(ERR_RETRACEMENT_INVALID);
  });

  it('px that rounds to 0 at the coin\'s price decimals → "Error converting float to price" (BTC 1 dp)', () => {
    for (const v of ['0', '0.05', '0.01', '0.001', '0.000001']) expect(px(v)).toBe(ERR_PRICE_CONVERT);
    expect(px('0.05', 4)).toBeNull();   // ETH has 2 price decimals → 0.05 is fine
    expect(px('0.05', 2)).toBeNull();   // SOL has 4
  });

  it('px / activationPx that are not numbers → "Error converting float to price" (message UNCONFIRMED)', () => {
    expect(px('abc')).toBe(ERR_PRICE_CONVERT);
    expect(validateTrailingStop(ok({ activationPx: 'abc' }), SZ_DEC)).toBe(ERR_PRICE_CONVERT);
    expect(validateTrailingStop(ok({ activationPx: '0' }), SZ_DEC)).toBe(ERR_PRICE_CONVERT);
  });

  it('size 0 / non-numeric → size error', () => {
    expect(validateTrailingStop(ok({ sz: '0' }), SZ_DEC)).toMatch(/Invalid order size/);
    expect(validateTrailingStop(ok({ sz: 'abc' }), SZ_DEC)).toMatch(/Invalid order size/);
  });
});

describe('px normalisation to the coin\'s price decimals (6 − szDecimals), truncating', () => {
  it('ETH px 0.123 → 0.12, SOL keeps 0.123, BTC 0.15 → 0.1, and the echoed text uses the normalised value', () => {
    expect(normalizePx('0.123', 4).toFixed()).toBe('0.12');
    expect(normalizePx('0.123', 2).toFixed()).toBe('0.123');
    expect(normalizePx('0.15', 5).toFixed()).toBe('0.1');       // truncation: half-up would give 0.2
    const eth = paramsFromWire({ type: 'trailingStop', asset: 4, isBuy: false, sz: '0.005', reduceOnly: true, retracement: { px: '0.123' }, activationPx: null }, 4);
    expect(eth.value).toBe('0.12');
    expect(triggerConditionText(eth, { activated: true, best: '2399.4' })).toBe('Activation immediate, retracement 0.12, best 2399.4');
  });
});

describe('px upper bound against the reference price (sell stops)', () => {
  const sell = (over: Partial<TrailingParams> = {}): TrailingParams => ({ isBuy: false, kind: 'px', value: '100000', activationPx: null, szDecimals: SZ_DEC, ...over });
  it('a sell px at/above the mark is "Trailing stop retracement is invalid." (BTC ≈ 81k, px 100000 / 1000000 / 99999999)', () => {
    for (const v of ['100000', '1000000', '99999999']) expect(validatePxAgainstReference(sell({ value: v }), '81400')).toBe(ERR_RETRACEMENT_INVALID);
    expect(validatePxAgainstReference(sell({ value: '81400' }), '81400')).toBe(ERR_RETRACEMENT_INVALID);
    expect(validatePxAgainstReference(sell({ value: '3000' }), '81400')).toBeNull();
  });
  it('uses the activation price as the reference while waiting; buys and pct are never rejected here', () => {
    expect(validatePxAgainstReference(sell({ value: '90000', activationPx: '86000' }), '81400')).toBe(ERR_RETRACEMENT_INVALID);
    expect(validatePxAgainstReference(sell({ isBuy: true }), '81400')).toBeNull();
    expect(validatePxAgainstReference(sell({ kind: 'pct', value: '5' }), '81400')).toBeNull();
  });
});

describe('remainder of a finished stop (margin-partial vs reduce-only clamp)', () => {
  it('shows the unfilled remainder after a partial fill, 0.0 after a full fill or a reduce-only clamp', () => {
    expect(remainderSz({ sz: '0.00516', filledSz: '0.0008' })).toBe('0.00436');   // T8: HL printed 0.00436
    expect(remainderSz({ sz: '0.00045', filledSz: '0.00045' })).toBe('0.0');       // T1: clamp records the whole stop as filled
    expect(remainderSz({ sz: '0.00015', filledSz: '0.00015' })).toBe('0.0');
  });
});

describe('HL-shaped bodies', () => {
  const hash = {
    oid: '62156953329', coin: 'BTC', isBuy: 'false', sz: '0.00015', reduceOnly: 'true',
    limitPx: '71735', triggerPx: '79705', createdAt: '1791457493480', updatedAt: '1791457498505',
    ...fieldsFrom(
      { isBuy: false, kind: 'px', value: '3000', activationPx: null, szDecimals: SZ_DEC },
      { activated: true, best: '82705' },
    ),
  } as Record<string, string>;

  it('open body = frontendOpenOrders row in HL field order', () => {
    const b = buildTrailingBody(hash, false);
    expect(Object.keys(b)).toEqual([
      'coin', 'side', 'limitPx', 'sz', 'oid', 'timestamp', 'triggerCondition', 'isTrigger', 'triggerPx',
      'children', 'isPositionTpsl', 'reduceOnly', 'orderType', 'origSz', 'tif', 'cloid',
    ]);
    expect(b).toMatchObject({
      limitPx: '71735.0', sz: '0.00015', timestamp: 1791457493480, isTrigger: true,
      triggerCondition: 'Activation immediate, retracement 3000, best 82705',
      triggerPx: '79705.0', orderType: 'Trailing Stop Market', tif: null, cloid: null, reduceOnly: true,
    });
  });

  it('triggerPx is "0.0" before activation even though a limitPx exists', () => {
    const waiting = { ...hash, trActivated: 'false', trBest: '', trActPx: '86066', triggerPx: '' };
    const b = buildTrailingBody(waiting, false);
    expect(b.triggerPx).toBe('0.0');
    expect(b.triggerCondition).toBe('Activation above 86066, retracement 3000, best waiting');
  });

  it('fired body: Triggered / isTrigger false / sz 0.0 / tif Gtc / timestamp = fill time', () => {
    const b = buildTrailingBody({ ...hash, status: 'filled', filledSz: '0.00015' }, true); // a filled order always records filledSz
    expect(b).toMatchObject({
      sz: '0.0', triggerCondition: 'Triggered', isTrigger: false, triggerPx: '0.0',
      tif: 'Gtc', timestamp: 1791457498505, origSz: '0.00015', limitPx: '71735.0',
    });
  });

  it('openOrders row is plain; reduceOnly only when true', () => {
    expect(buildTrailingOpenOrderRow(hash)).toEqual({
      coin: 'BTC', side: 'A', limitPx: '71735.0', sz: '0.00015', oid: 62156953329,
      timestamp: 1791457493480, origSz: '0.00015', reduceOnly: true,
    });
    const buy = buildTrailingOpenOrderRow({ ...hash, isBuy: 'true', reduceOnly: 'false' });
    expect('reduceOnly' in buy).toBe(false);
  });

  it('hash round-trip preserves params/state', () => {
    const { params, state } = readTrailing(hash);
    expect(params).toEqual({ isBuy: false, kind: 'px', value: '3000', activationPx: null, szDecimals: SZ_DEC });
    expect(state).toEqual({ activated: true, best: '82705' });
  });
});
