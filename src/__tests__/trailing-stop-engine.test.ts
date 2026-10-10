import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();
vi.mock('../store/redis.js', () => ({ redis: redisMock }));

const mockConfig: Record<string, unknown> = {
  FEES_ENABLED: true,
  FEE_RATE_TAKER: '0.00035',
  FEE_RATE_MAKER: '0.0001',
  LOG_LEVEL: 'silent',
  HL_API_URL: 'https://hl.test',
  TRAILING_ORDERSTATUS_LIVE: false,
};
vi.mock('../config.js', () => ({ config: mockConfig }));

// No order book → fills price at the mid (computeFillPrice falls back to it).
vi.mock('../utils/l2-cache.js', () => ({ getL2Book: vi.fn().mockResolvedValue(null) }));

let idCounter = 1000;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => ++idCounter),
  nextTid: vi.fn(async () => ++idCounter),
}));

const sharedEventBus = new EventEmitter();
vi.mock('../worker/index.js', () => ({ eventBus: sharedEventBus }));

// Margin is a DB-backed calculation elsewhere. At FIRE time HL fills what the margin allows: `affordable` is the
// largest size the account can still take (null = not margin-constrained).
let affordable: string | null = null;
const maxAffordableOrderSize = vi.fn(async (..._a: unknown[]) => affordable);
vi.mock('../engine/margin.js', () => ({ checkMarginForOrder: vi.fn(async () => true), maxAffordableOrderSize }));

const { OrderMatcher } = await import('../worker/order-matcher.js');
const { placeTrailingStop } = await import('../engine/trailingStop.js');
const { cancelOrders, modifyOrder } = await import('../engine/order.js');
const { getFrontendOpenOrders, getOpenOrders, getOrderStatus } = await import('../engine/position.js');
const { ERR_ALREADY_FINISHED, ERR_RETRACEMENT_INVALID, ERR_PERCENTAGE_INVALID, ERR_PRICE_CONVERT, ERR_MODIFY_INVALID } = await import('../engine/trailing-math.js');
const { shapeOrderUpdate } = await import('../ws/order-updates.js');

const USER = '0xuser';
const OTHER = '0xother';
const COIN = 'BTC';
const ASSET = 0;

const act = (over: Record<string, unknown> = {}) => ({
  type: 'trailingStop' as const, asset: ASSET, isBuy: false, sz: '0.00015', reduceOnly: true,
  retracement: { px: '5' } as { px: string } | { pct: string }, activationPx: null as string | null, ...over,
});

describe('trailing stop — placement + engine on the MARK', () => {
  let matcher: InstanceType<typeof OrderMatcher>;
  let orderEvents: Array<{ userId: string; order: any; status: string }>;
  let fills: Array<{ userId: string; fill: any }>;
  let batches: Array<{ userId: string; updates: Array<{ order: any; status: string }> }>;
  let history: Array<{ oid: number; status: string; statusTimestamp: number; body: any }>;

  async function setMark(px: string, ageMs = 0) {
    await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', px, 'markTs', String(Date.now() - ageMs));
  }
  const setMid = (px: string) => redisMock.hset(KEYS.MARKET_MIDS, COIN, px);

  async function seedLong(szi = '0.00015') {
    await redisMock.hset(KEYS.USER_POS(USER, ASSET), 'userId', USER, 'asset', String(ASSET), 'coin', COIN, 'szi', szi, 'entryPx', '80000', 'cumFunding', '0', 'cumFundingSinceOpen', '0', 'cumFundingSinceChange', '0');
    await redisMock.sadd(KEYS.USER_POSITIONS_SCOPED(USER, ''), String(ASSET));
  }

  beforeEach(async () => {
    redisMock.flushall();
    idCounter = 1000;
    affordable = null;
    maxAffordableOrderSize.mockClear();
    mockConfig.TRAILING_ORDERSTATUS_LIVE = false;
    sharedEventBus.removeAllListeners();
    matcher = new OrderMatcher(sharedEventBus);
    orderEvents = [];
    fills = [];
    batches = [];
    history = [];
    sharedEventBus.on('orderUpdateBatch', (e) => batches.push(e));
    sharedEventBus.on('trailingHistory', (e) => history.push(e));
    sharedEventBus.on('orderUpdate', (e) => orderEvents.push(e));
    sharedEventBus.on('fill', (e) => fills.push(e));
    await redisMock.set(KEYS.MARKET_META, JSON.stringify({ universe: [{ name: COIN, szDecimals: 5 }, { name: 'ETH', szDecimals: 4 }] }));
    await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', '1000');
  });

  async function place(over: Record<string, unknown> = {}) {
    const r = await placeTrailingStop(USER, act(over));
    if ('error' in r) throw new Error(`placement failed: ${r.error}`);
    return r.oid;
  }
  const row = async (oid: number) => (await getFrontendOpenOrders(USER)).find((o) => o.oid === oid);

  // ── placement ─────────────────────────────────────────────────────────────

  it('places, returns an oid, seeds best from the MARK, and lives only in the trailing set', async () => {
    await setMark('82760.2');
    await seedLong();
    const oid = await place();

    expect(await redisMock.smembers(KEYS.ORDERS_TRAILING)).toEqual([String(oid)]);
    expect(await redisMock.smembers(KEYS.ORDERS_OPEN)).toEqual([]);      // limit matcher never sees it
    expect(await redisMock.smembers(KEYS.ORDERS_TRIGGERS)).toEqual([]);  // nor the TP/SL matcher

    const r = await row(oid);
    expect(r).toMatchObject({
      coin: 'BTC', side: 'A', sz: '0.00015', orderType: 'Trailing Stop Market', isTrigger: true,
      triggerCondition: 'Activation immediate, retracement 5, best 82760.2',
      triggerPx: '82755.2', reduceOnly: true, tif: null, cloid: null, children: [], isPositionTpsl: false,
    });
    expect(r!.limitPx).toBe('74480.0'); // floor(82755.2 × 0.9)+1 — the value HL printed for this exact case
    expect(orderEvents.map((e) => [e.order.oid, e.status])).toEqual([[oid, 'open']]);
  });

  it('openOrders is plain: no trailing fields, reduceOnly only when true', async () => {
    await setMark('82760.2');
    const sell = await place();
    const buy = await place({ isBuy: true, reduceOnly: false });
    const rows = await getOpenOrders(USER);
    const s = rows.find((o: any) => o.oid === sell)!;
    const b = rows.find((o: any) => o.oid === buy)!;
    expect(Object.keys(s)).toEqual(['coin', 'side', 'limitPx', 'sz', 'oid', 'timestamp', 'origSz', 'reduceOnly']);
    expect(Object.keys(b)).toEqual(['coin', 'side', 'limitPx', 'sz', 'oid', 'timestamp', 'origSz']);
  });

  it('does NOT check margin at placement and does NOT require a position (HL accepts both)', async () => {
    await setMark('82760.2');
    await redisMock.hset(KEYS.USER_ACCOUNT(OTHER), 'userId', OTHER, 'balance', '0');
    affordable = '0';
    // buy stop, zero balance
    const buy = await placeTrailingStop(OTHER, act({ isBuy: true, reduceOnly: false }));
    expect('oid' in buy).toBe(true);
    // reduce-only sell stop on a FLAT account, size bigger than any position
    const flat = await placeTrailingStop(OTHER, act({ sz: '999' }));
    expect('oid' in flat).toBe(true);
    expect(maxAffordableOrderSize).not.toHaveBeenCalled();
  });

  it("returns HL's exact strings for the two probed rejections and nothing is created", async () => {
    await setMark('82760.2');
    expect(await placeTrailingStop(USER, act({ retracement: { pct: '0.0000%' } }))).toEqual({ error: ERR_RETRACEMENT_INVALID });
    expect(await placeTrailingStop(USER, act({ retracement: { px: '0' } }))).toEqual({ error: 'Error converting float to price' });
    expect(await redisMock.smembers(KEYS.ORDERS_TRAILING)).toEqual([]);
  });

  it('unknown asset / spot asset ids are rejected', async () => {
    await setMark('82760.2');
    expect(await placeTrailingStop(USER, act({ asset: 7 }))).toEqual({ error: 'Unknown asset 7' });
    expect(await placeTrailingStop(USER, act({ asset: 10_001 }))).toEqual({ error: 'Unknown asset 10001' });
  });

  it('no usable mark → clear error (a boot-seeded mark without a timestamp is not "fresh")', async () => {
    await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', '82000'); // no markTs
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await placeTrailingStop(USER, act())).toEqual({ error: 'No market price available' });
    fetchSpy.mockRestore();
  });

  // ── mark, not mid ─────────────────────────────────────────────────────────

  it('runs on the MARK: mids crossing the trigger do nothing, and a stale mark never trades', async () => {
    await setMark('82760.2');
    await setMid('82760');
    await seedLong();
    const oid = await place();

    await setMid('70000'); // mid collapses — irrelevant
    await matcher.matchAll();
    expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('open');

    await setMark('82700', 20_000); // mark crossed the trigger but is 20 s old
    await matcher.matchAll();
    expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('open');
    expect(fills).toHaveLength(0);
  });

  // ── ratchet ───────────────────────────────────────────────────────────────

  it('sell ratchets up only; persists best/triggerPx/limitPx; a dip keeps them', async () => {
    await setMark('82719');
    await seedLong();
    const oid = await place();
    await setMark('82730');
    await matcher.matchAll();
    let r = (await row(oid))!;
    expect(r.triggerCondition).toBe('Activation immediate, retracement 5, best 82730');
    expect(r.triggerPx).toBe('82725.0');

    await setMark('82727'); // dip, still above trigger
    await matcher.matchAll();
    r = (await row(oid))!;
    expect(r.triggerCondition).toBe('Activation immediate, retracement 5, best 82730');
    expect(r.triggerPx).toBe('82725.0');
    expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('open');
  });

  // ── activation ────────────────────────────────────────────────────────────

  it('activation: "best waiting"/triggerPx "0.0" until the mark reaches it, then seeds best (sell)', async () => {
    await setMark('82755');
    await seedLong();
    const oid = await place({ activationPx: '82761', retracement: { px: '3000' } });

    let r = (await row(oid))!;
    expect(r.triggerCondition).toBe('Activation above 82761, retracement 3000, best waiting');
    expect(r.triggerPx).toBe('0.0');
    expect(r.limitPx).toBe('71785.0'); // from the activation price: floor((82761-3000)×0.9)+1 — HL printed 71785

    await setMark('82757'); await matcher.matchAll();
    expect((await row(oid))!.triggerCondition).toContain('best waiting');

    await setMark('82762'); await matcher.matchAll();
    r = (await row(oid))!;
    expect(r.triggerCondition).toBe('Activation above 82761, retracement 3000, best 82762');
    expect(r.triggerPx).toBe('79762.0');
    expect(r.limitPx).toBe('71786.0'); // HL: 71785 → 71786 at activation
  });

  it('activation on the "wrong side" is accepted and active immediately (sell, activation below mark)', async () => {
    await setMark('82705');
    const oid = await place({ activationPx: '82680', retracement: { px: '3000' } });
    expect((await row(oid))!).toMatchObject({
      triggerCondition: 'Activation above 82680, retracement 3000, best 82705', triggerPx: '79705.0',
    });
  });

  // ── firing ────────────────────────────────────────────────────────────────

  it('SELL fires on mark <= trigger: SAME oid, taker market fill, closes the long, final body "Triggered"', async () => {
    await setMark('82760.2');
    await setMid('82750');
    await seedLong();
    const oid = await place(); // best 82760.2 → trigger 82755.2

    await setMark('82755.3'); await matcher.matchAll();
    expect(fills).toHaveLength(0); // above the trigger: no fire

    await setMark('82755.2'); await matcher.matchAll(); // == trigger → fires (inclusive)
    expect(fills).toHaveLength(1);
    const f = fills[0].fill;
    expect(f).toMatchObject({ oid, coin: 'BTC', side: 'A', dir: 'Close Long', crossed: true, sz: '0.00015', px: '82750' });
    expect(Number(f.fee)).toBeGreaterThan(0); // taker fee
    expect(await redisMock.hgetall(KEYS.USER_POS(USER, ASSET))).toEqual({}); // position closed
    expect(await redisMock.smembers(KEYS.ORDERS_TRAILING)).toEqual([]);
    expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('filled');
    // HL delivers a fired stop as ONE frame [triggered, filled] — a batch, not two orderUpdate events.
    expect(batches).toHaveLength(1);
    expect(batches[0].updates.map((u) => [u.order.oid, u.status])).toEqual([[oid, 'triggered'], [oid, 'filled']]);
    expect(orderEvents.map((e) => e.status)).toEqual(['open']); // only the placement 'open' went out singly
    // history rows: open (placement) → triggered (live state frozen at the trigger) → filled (final body)
    expect(history.map((h) => h.status)).toEqual(['open', 'triggered', 'filled']);
    expect(history[0].body.triggerCondition).toBe('Activation immediate, retracement 5, best 82760.2');
    expect(history[1].body).toMatchObject({ isTrigger: true, tif: null, sz: '0.00015' });
    expect(history[2].body).toMatchObject({ triggerCondition: 'Triggered', isTrigger: false, sz: '0.0', tif: 'Gtc' });
    expect(history[1].statusTimestamp).toBe(history[2].statusTimestamp); // same ms, as on HL
    expect(await row(oid)).toBeUndefined(); // gone from frontendOpenOrders

    const st: any = await getOrderStatus(oid);
    expect(st.status).toBe('order');
    expect(st.order.status).toBe('filled');
    expect(st.order.order).toMatchObject({
      sz: '0.0', origSz: '0.00015', triggerCondition: 'Triggered', isTrigger: false,
      triggerPx: '0.0', tif: 'Gtc', orderType: 'Trailing Stop Market',
    });
    expect(st.order.statusTimestamp).toBe(st.order.order.timestamp); // HL: final body timestamp = fill time
  });

  it('BUY (open long) fires on mark >= trigger after ratcheting DOWN, margin checked only now', async () => {
    await setMark('82831');
    await setMid('82830');
    const oid = await place({ isBuy: true, reduceOnly: false, retracement: { px: '5' } });
    await setMark('82822'); await matcher.matchAll();
    expect((await row(oid))!.triggerPx).toBe('82827.0');
    await setMark('82826'); await matcher.matchAll(); // rise but below trigger; best unchanged
    expect((await row(oid))!.triggerCondition).toContain('best 82822');
    expect(maxAffordableOrderSize).not.toHaveBeenCalled();

    await setMark('82827'); await matcher.matchAll(); // == trigger
    expect(maxAffordableOrderSize).toHaveBeenCalledTimes(1);
    expect(fills[0].fill).toMatchObject({ oid, side: 'B', dir: 'Open Long', crossed: true, px: '82830' });
    expect((await redisMock.hgetall(KEYS.USER_POS(USER, ASSET))).szi).toBe('0.00015');
  });

  it('margin short at FIRE time → PARTIAL fill up to what is affordable; ends filled with the remainder in sz (HL T8)', async () => {
    await setMark('82831'); await setMid('82830');
    const oid = await place({ isBuy: true, reduceOnly: false, sz: '0.00516' });
    affordable = '0.00080999';                       // floors to the coin's 5 size decimals → 0.0008
    await setMark('82840'); await matcher.matchAll();

    expect(fills).toHaveLength(1);
    expect(fills[0].fill).toMatchObject({ oid, dir: 'Open Long', sz: '0.0008', crossed: true });
    expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('filled');
    expect(await redisMock.hget(KEYS.ORDER(oid), 'filledSz')).toBe('0.0008');
    expect((await redisMock.hgetall(KEYS.USER_POS(USER, ASSET))).szi).toBe('0.0008');

    const st: any = await getOrderStatus(oid);
    expect(st.order.status).toBe('filled');
    expect(st.order.order).toMatchObject({ sz: '0.00436', origSz: '0.00516', triggerCondition: 'Triggered', isTrigger: false, tif: 'Gtc' });
    expect(history.map((h) => h.status)).toEqual(['open', 'triggered', 'filled']);
    expect(history[2].body.sz).toBe('0.00436');

    // the ONE frame: [triggered (full sz), filled (sz = remainder)]
    expect(batches).toHaveLength(1);
    const frame = batches[0].updates.map((u) => shapeOrderUpdate(u.order, u.status));
    expect(frame.map((e) => [e.status, e.order.sz])).toEqual([['triggered', '0.00516'], ['filled', '0.00436']]);
  });

  it('margin short AND nothing affordable → marginCanceled AFTER a triggered row; one [triggered, marginCanceled] frame (HL T8b)', async () => {
    await setMark('82831'); await setMid('82830');
    const oid = await place({ isBuy: true, reduceOnly: false, sz: '0.00477' });
    affordable = '0';
    await setMark('82840'); await matcher.matchAll();

    expect(fills).toHaveLength(0);
    expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('marginCanceled');
    expect(await redisMock.smembers(KEYS.ORDERS_TRAILING)).toEqual([]);
    expect(history.map((h) => h.status)).toEqual(['open', 'triggered', 'marginCanceled']);
    expect(history[1].statusTimestamp).toBe(history[2].statusTimestamp);          // same ms, as on HL
    expect(batches).toHaveLength(1);
    const frame = batches[0].updates.map((u) => shapeOrderUpdate(u.order, u.status));
    expect(frame.map((e) => [e.status, e.order.sz, e.order.timestamp === frame[0].order.timestamp])).toEqual([
      ['triggered', '0.00477', true], ['marginCanceled', '0.00477', true],         // both keep the full sz + placement ts
    ]);
    const st: any = await getOrderStatus(oid);
    expect(st.order.status).toBe('marginCanceled');
    expect(st.order.order).toMatchObject({ sz: '0.00477', isTrigger: true });       // frozen live body, like the orphan case
  });

  it('sub-step affordable size counts as zero (rounds down below one size step)', async () => {
    await setMark('82831'); await setMid('82830');
    const oid = await place({ isBuy: true, reduceOnly: false });
    affordable = '0.000009';                          // < 1e-5, the BTC size step
    await setMark('82840'); await matcher.matchAll();
    expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('marginCanceled');
  });

  it('a reduce-only stop is never margin-checked, even when no margin is free', async () => {
    await setMark('82760.2'); await setMid('82750');
    await seedLong();
    const oid = await place();
    affordable = '0';
    await setMark('82700'); await matcher.matchAll();
    expect(maxAffordableOrderSize).not.toHaveBeenCalled();
    expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('filled');
  });

  it('oversize reduce-only stop fires: fill = position, final body sz "0.0" (HL T1)', async () => {
    await setMark('82760.2'); await setMid('82750');
    await seedLong('0.00015');
    const oid = await place({ sz: '0.00045' });
    await setMark('82700'); await matcher.matchAll();
    expect(fills[0].fill).toMatchObject({ oid, sz: '0.00015', dir: 'Close Long' });
    const st: any = await getOrderStatus(oid);
    expect(st.order.order).toMatchObject({ sz: '0.0', origSz: '0.00045' });
    const frame = batches[0].updates.map((u) => shapeOrderUpdate(u.order, u.status));
    expect(frame.map((e) => [e.status, e.order.sz])).toEqual([['triggered', '0.00045'], ['filled', '0.0']]);
  });

  // ── placement validation (round 6) ─────────────────────────────────────────

  it('pct is validated with HL\'s messages: format / granularity → Percentage is invalid; 0 or >= 100 → retracement invalid', async () => {
    await setMark('82760.2');
    for (const v of ['5', '5.0000', '%5', ' 5.0000%', '0.0001%', '99.9999%']) {
      expect(await placeTrailingStop(USER, act({ retracement: { pct: v } }))).toEqual({ error: ERR_PERCENTAGE_INVALID });
    }
    for (const v of ['0.0000%', '100.0000%', '150.0000%']) {
      expect(await placeTrailingStop(USER, act({ retracement: { pct: v } }))).toEqual({ error: ERR_RETRACEMENT_INVALID });
    }
    for (const v of ['5%', '5.0%', '05.0000%', '5.00000%', '0.0010%']) {
      expect('oid' in (await placeTrailingStop(USER, act({ retracement: { pct: v } })))).toBe(true);
    }
  });

  it('px is normalised to the coin\'s price decimals and the NORMALISED value is echoed (ETH 0.123 → 0.12); BTC 0.05 rounds to 0 → rejected', async () => {
    await setMark('82760.2');
    expect(await placeTrailingStop(USER, act({ retracement: { px: '0.05' } }))).toEqual({ error: ERR_PRICE_CONVERT });
    expect(await placeTrailingStop(USER, act({ retracement: { px: '0.0001' } }))).toEqual({ error: ERR_PRICE_CONVERT });
    const ok = await placeTrailingStop(USER, act({ retracement: { px: '0.1' } }));
    expect('oid' in ok).toBe(true);

    // ETH (asset 1, szDecimals 4 → 2 price decimals)
    await redisMock.hset(KEYS.MARKET_CTX('ETH'), 'markPx', '2399.4', 'markTs', String(Date.now()));
    const eth = await placeTrailingStop(USER, act({ asset: 1, sz: '0.0051', retracement: { px: '0.123' } }));
    if ('error' in eth) throw new Error(eth.error);
    const row = (await getFrontendOpenOrders(USER)).find((o) => o.oid === eth.oid)!;
    expect(row.triggerCondition).toBe('Activation immediate, retracement 0.12, best 2399.4');
    expect(row.triggerPx).toBe('2399.28');                    // 2399.4 − 0.12 — what HL printed
  });

  it('a sell px at/above the reference price is "Trailing stop retracement is invalid." (BTC px 100000 / 1000000 / 99999999)', async () => {
    await setMark('82760.2');
    for (const v of ['100000', '1000000', '99999999']) {
      expect(await placeTrailingStop(USER, act({ retracement: { px: v } }))).toEqual({ error: ERR_RETRACEMENT_INVALID });
    }
    expect(await redisMock.smembers(KEYS.ORDERS_TRAILING)).toEqual([]);
    // a BUY stop with a large px is not rejected (buy side was not probed → no invented rejection)
    expect('oid' in (await placeTrailingStop(USER, act({ isBuy: true, reduceOnly: false, retracement: { px: '100000' } })))).toBe(true);
  });

  it('expiresAfter never expires the order: nothing is registered for expiry and the stop survives the sweep', async () => {
    await setMark('82760.2');
    const oid = await place();
    expect(await redisMock.zrange(KEYS.ORDERS_EXPIRY, 0, -1)).toEqual([]);
    expect(await redisMock.hget(KEYS.ORDER(oid), 'expiresAfter')).toBeNull();
    await matcher.matchAll();
    expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('open');
  });

  it('a reduce-only stop with nothing to reduce keeps resting when its trigger is hit (HL leaves it open)', async () => {
    await setMark('82760'); await setMid('82760');
    const oid = await place(); // flat account
    await setMark('82000'); await matcher.matchAll();
    expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('open');
    expect(fills).toHaveLength(0);
  });

  it('tight 0.01 % pct stop: triggerPx = best × (1 − rate) rounded to 1 dp, then fires', async () => {
    await setMark('82719'); await setMid('82714');
    await seedLong();
    const oid = await place({ retracement: { pct: '0.0100%' } });
    expect((await row(oid))!).toMatchObject({ triggerPx: '82710.7', triggerCondition: 'Activation immediate, retracement 0.01%, best 82719' });
    await setMark('82710'); await matcher.matchAll();
    expect(fills[0].fill).toMatchObject({ oid, dir: 'Close Long' });
  });

  // ── orderStatus: HL serves a FROZEN snapshot (D1) ─────────────────────────

  it('orderStatus is a frozen placement snapshot while frontendOpenOrders is live (HL parity); env flag switches it to live', async () => {
    await setMark('82719');
    await seedLong();
    const oid = await place();
    await setMark('82730'); await matcher.matchAll();

    expect((await row(oid))!.triggerCondition).toContain('best 82730'); // live
    const frozen: any = await getOrderStatus(oid);
    expect(frozen.order.status).toBe('open');
    expect(frozen.order.order.triggerCondition).toContain('best 82719'); // stale, like HL
    expect(frozen.order.order.triggerPx).toBe('82714.0');

    mockConfig.TRAILING_ORDERSTATUS_LIVE = true;
    const live: any = await getOrderStatus(oid);
    expect(live.order.order.triggerCondition).toContain('best 82730');
  });

  // ── cancel + modify ───────────────────────────────────────────────────────

  it('cancels through the normal cancel action; later cancels return HL\'s "already canceled or filled" text', async () => {
    await setMark('82719');
    const oid = await place();
    expect(await cancelOrders(USER, [{ a: ASSET, o: oid }])).toEqual(['success']);
    expect(history.map((h) => h.status)).toEqual(['open', 'canceled']);
    expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('cancelled');
    expect(await redisMock.smembers(KEYS.ORDERS_TRAILING)).toEqual([]);
    expect(await row(oid)).toBeUndefined();
    const st: any = await getOrderStatus(oid);
    expect(st.order.status).toBe('canceled'); // US spelling, as HL
    expect(st.order.order.triggerCondition).toContain('best 82719'); // frozen at cancel

    expect(await cancelOrders(USER, [{ a: ASSET, o: oid }])).toEqual([{ error: ERR_ALREADY_FINISHED(ASSET) }]);
  });

  it('cancel after the stop already filled also returns the HL text', async () => {
    await setMark('82760'); await setMid('82750');
    await seedLong();
    const oid = await place();
    await setMark('82700'); await matcher.matchAll();
    expect(await cancelOrders(USER, [{ a: ASSET, o: oid }])).toEqual([{ error: ERR_ALREADY_FINISHED(ASSET) }]);
  });

  it('another user cannot cancel it', async () => {
    await setMark('82719');
    const oid = await place();
    expect(await cancelOrders(OTHER, [{ a: ASSET, o: oid }])).toEqual([{ error: `Order ${oid} not found` }]);
  });

  it('modify is refused with HL\'s text and the stop is untouched (round 6, T7)', async () => {
    await setMark('82719');
    const oid = await place();
    const r = await modifyOrder(USER, oid, { a: ASSET, b: false, p: '80000', s: '0.00015', r: true, t: { limit: { tif: 'Gtc' } } } as any);
    expect(r).toEqual({ error: ERR_MODIFY_INVALID }); // HL: "Attempted to modify to invalid new order"
    expect(await redisMock.hget(KEYS.ORDER(oid), 'status')).toBe('open');
  });

  // ── persistence ───────────────────────────────────────────────────────────

  it('state survives a "restart": a brand-new matcher resumes from the persisted best and fires', async () => {
    await setMark('82719'); await setMid('82700');
    await seedLong();
    const oid = await place();
    await setMark('82730'); await matcher.matchAll(); // ratchet persisted to Redis

    const restarted = new OrderMatcher(sharedEventBus); // fresh process
    await setMark('82724'); // below persisted trigger 82725 (from best 82730)
    await restarted.matchAll();
    expect(fills).toHaveLength(1);
    expect(fills[0].fill.oid).toBe(oid);
  });
});
