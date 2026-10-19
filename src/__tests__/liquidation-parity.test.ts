/**
 * Liquidation + leverage parity with HL (docs: Trading → Liquidations, Margining;
 * shapes from public HL userFills / userNonFundingLedgerUpdates, 2026-10-19).
 *
 * The opening case is the production incident: paper 0x4420a11032c3e68c4442efd1bc5f33442931c75c
 * held XMR (HL max 5x) at an isolated 10x — accepted because leverage was never capped — and
 * was liquidated by a $0.50 move seven seconds after the fill, with NO fill written, margin
 * credited back to the balance, and the same amount credited to the vault.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { D } from '../utils/math.js';

vi.mock('../store/redis.js', async () => {
  const { RedisMock } = await import('./helpers/redis-mock.js');
  return { redis: new RedisMock() };
});
vi.mock('../config.js', () => ({
  config: {
    LIQUIDATOR_VAULT_ADDRESS: '0x410Ce828C9EcD89ae9Ad9Bab89ec98036C7f07a4',
    LOG_LEVEL: 'silent',
    FEES_ENABLED: true,
    FEE_RATE_TAKER: '0.00045',
    FEE_RATE_MAKER: '0.00015',
    HL_API_URL: 'https://api.hyperliquid.xyz',
  },
}));
vi.mock('../store/pg-queries.js', () => ({
  insertLiquidationEventPg: vi.fn(async () => {}),
  creditVaultPg: vi.fn(async () => {}),
  ensureVaultRowPg: vi.fn(async () => {}),
}));
vi.mock('../store/pg-sink.js', () => ({
  recordTwapActivated: vi.fn(), recordTwapHistory: vi.fn(),
}));
const getL2Book = vi.fn(async (_coin: string): Promise<unknown> => null);
vi.mock('../utils/l2-cache.js', () => ({ getL2Book }));
let idCounter = 0;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => ++idCounter),
  nextTid: vi.fn(async () => ++idCounter),
}));
const bus = new EventEmitter();
vi.mock('../worker/index.js', () => ({ eventBus: bus }));

const { redis } = await import('../store/redis.js');
const { KEYS } = await import('../store/keys.js');
const { checkLiquidation, checkAndLiquidateUser, checkAndLiquidateAll, executeLiquidation, backfillPositionHolders, positionCoins } =
  await import('../engine/liquidation.js');
const { updateLeverage, placeSingleOrder, ERR_INVALID_LEVERAGE } = await import('../engine/order.js');
const { getLeverageSetting } = await import('../engine/assetMeta.js');
const { calculateLiquidationPrice, calculatePositionMarginUsed, isolatedMarginOf } = await import('../engine/margin.js');
const { OrderMatcher } = await import('../worker/order-matcher.js');
const { withUserLock } = await import('../utils/userLock.js');
const r = redis as unknown as import('./helpers/redis-mock.js').RedisMock;

const USER = '0x4420a11032c3e68c4442efd1bc5f33442931c75c';
/** engine/liquidator-vault.ts VAULT_KEY (attached to KEYS only at runtime). */
const VAULT_KEY = 'liquidator:vault';
const META = {
  universe: [
    { name: 'XMR', szDecimals: 3, maxLeverage: 5 },   // asset 0 — HL: XMR maxLeverage 5
    { name: 'BTC', szDecimals: 5, maxLeverage: 40 },  // asset 1
    { name: 'TIER', szDecimals: 2, maxLeverage: 10, marginTableId: 77 }, // asset 2 — two-tier schedule
  ],
  marginTables: [[77, { description: '', marginTiers: [
    { lowerBound: '0.0', maxLeverage: 10 },
    { lowerBound: '1000.0', maxLeverage: 5 },
  ] }]],
};

let events: Record<string, any[]>;
function record(name: string) { bus.on(name, (e) => events[name].push(e)); }

async function seedPosition(user: string, asset: number, coin: string, fields: Record<string, string>, scope = '') {
  await r.hset(KEYS.USER_POS(user, asset), { userId: user, asset: String(asset), coin, ...fields });
  await r.sadd(KEYS.USER_POSITIONS_SCOPED(user, scope), String(asset));
  await r.sadd(KEYS.POSITION_HOLDERS, `${user}|${scope}`);
  await r.sadd(KEYS.USERS_ACTIVE, user);
}
const bal = async (user = USER, field = 'balance') => (await r.hget(KEYS.USER_ACCOUNT(user), field)) ?? '0';
const fills = async (user = USER) => (await r.lrange(KEYS.USER_FILLS(user), 0, -1)).map((f) => JSON.parse(f));

beforeEach(async () => {
  r.flushall();
  bus.removeAllListeners();
  events = { fill: [], liquidationOrder: [], liquidationLedger: [], liquidationEvent: [], accountUpdate: [] };
  for (const name of Object.keys(events)) record(name);
  getL2Book.mockReset();
  getL2Book.mockResolvedValue(null);
  await r.set(KEYS.MARKET_META, JSON.stringify(META));
  // Default: HL unreachable → the cached meta is used.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

// ── 1. Leverage ──────────────────────────────────────────────────────────

describe('leverage is capped 1:1 with the asset\'s HL maxLeverage', () => {
  it('rejects above max, below 1 and non-integers; accepts the max', async () => {
    expect(await updateLeverage(USER, 0, false, 10)).toEqual({ error: ERR_INVALID_LEVERAGE });
    expect(await updateLeverage(USER, 0, false, 0)).toEqual({ error: ERR_INVALID_LEVERAGE });
    expect(await updateLeverage(USER, 0, false, 2.5)).toEqual({ error: ERR_INVALID_LEVERAGE });
    expect(await r.hgetall(KEYS.USER_LEV(USER, 0))).toEqual({});
    expect(await updateLeverage(USER, 0, false, 5)).toEqual({ ok: true });
    expect(await r.hgetall(KEYS.USER_LEV(USER, 0))).toEqual({ leverage: '5', isCross: 'false' });
  });

  it('reads the max LIVE from public HL /info meta and refreshes the cache (HL lowered XMR to 3)', async () => {
    const live = { ...META, universe: [{ name: 'XMR', szDecimals: 3, maxLeverage: 3 }, ...META.universe.slice(1)] };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => live }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await updateLeverage(USER, 0, true, 5)).toEqual({ error: ERR_INVALID_LEVERAGE });
    expect(fetchMock).toHaveBeenCalledWith('https://api.hyperliquid.xyz/info', expect.objectContaining({ body: JSON.stringify({ type: 'meta' }) }));
    expect(JSON.parse((await r.get(KEYS.MARKET_META))!).universe[0].maxLeverage).toBe(3);
  });

  it('a HIP-3 asset reads its own dex meta ({type:"meta", dex})', async () => {
    await r.set(KEYS.MARKET_PERPDEXS, JSON.stringify([null, { name: 'xyz' }]));
    const dexMeta = { universe: [{ name: 'xyz:AAPL', szDecimals: 2, maxLeverage: 10 }] };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => dexMeta }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await updateLeverage(USER, 110_000, true, 10)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('https://api.hyperliquid.xyz/info', expect.objectContaining({ body: JSON.stringify({ type: 'meta', dex: 'xyz' }) }));
    expect(await updateLeverage(USER, 110_000, true, 11)).toEqual({ error: ERR_INVALID_LEVERAGE });
  });

  it('cannot switch cross ↔ isolated with an open position', async () => {
    await seedPosition(USER, 0, 'XMR', { szi: '1', entryPx: '500' });
    expect(await updateLeverage(USER, 0, false, 3)).toEqual({ error: 'Cannot switch leverage type with open position' });
    expect(await updateLeverage(USER, 0, true, 3)).toEqual({ ok: true }); // same type, new leverage: allowed
  });

  it('unset leverage is HL\'s default: 20x cross capped at maxLeverage (XMR → 5, BTC → 20)', async () => {
    expect(await getLeverageSetting(USER, 0)).toEqual({ leverage: 5, isCross: true });
    expect(await getLeverageSetting(USER, 1)).toEqual({ leverage: 20, isCross: true });
  });

  it('a stored leverage above max blocks OPENING / growing, never reducing', async () => {
    await r.hset(KEYS.USER_LEV(USER, 0), 'leverage', '10', 'isCross', 'false'); // the incident's state
    await r.hset(KEYS.MARKET_MIDS, 'XMR', '558');
    const open = { a: 0, b: true, p: '100', s: '1', r: false, t: { limit: { tif: 'Gtc' as const } } };
    expect(await placeSingleOrder(USER, open, 'na')).toEqual({ error: ERR_INVALID_LEVERAGE });
    await seedPosition(USER, 0, 'XMR', { szi: '20', entryPx: '558.57' });
    const reduce = { a: 0, b: false, p: '900', s: '1', r: false, t: { limit: { tif: 'Gtc' as const } } };
    expect(await placeSingleOrder(USER, reduce, 'na')).not.toEqual({ error: ERR_INVALID_LEVERAGE });
  });
});

// ── 2. Isolated margin is allocated at open, not re-marked ─────────────────

describe('isolated margin allocation', () => {
  const order = (over: Record<string, unknown>) => ({
    oid: 1, userId: USER, asset: 0, coin: 'XMR', isBuy: true, sz: '10', limitPx: '100', orderType: 'limit',
    tif: 'Gtc', reduceOnly: false, grouping: 'na', status: 'open', filledSz: '0', avgPx: '0', createdAt: 1, updatedAt: 1, ...over,
  }) as any;

  it('open → size × price / leverage; grow adds; reduce releases proportionally; the mark never moves it', async () => {
    await r.hset(KEYS.USER_LEV(USER, 0), 'leverage', '5', 'isCross', 'false');
    const m = new OrderMatcher(bus);
    await (m as any).executeFill(order({ oid: 1 }), '100');                       // open 10 @ 100
    expect((await r.hgetall(KEYS.USER_POS(USER, 0))).marginAlloc).toBe('200');
    expect(await r.smembers(KEYS.POSITION_HOLDERS)).toEqual([`${USER}|`]);       // indexed for the liquidation scan
    expect(await calculatePositionMarginUsed(USER, 0, '10', '150')).toBe('200');  // mark 150: unchanged
    await (m as any).executeFill(order({ oid: 2, sz: '10' }), '120');              // grow 10 @ 120 → +240
    expect((await r.hgetall(KEYS.USER_POS(USER, 0))).marginAlloc).toBe('440');
    await (m as any).executeFill(order({ oid: 3, sz: '5', isBuy: false }), '130'); // reduce 5 of 20 → keep 3/4
    expect((await r.hgetall(KEYS.USER_POS(USER, 0))).marginAlloc).toBe('330');
  });

  it('prices the allocation at a fresh MARK when one is held (HL: size × mark_price / leverage)', async () => {
    await r.hset(KEYS.USER_LEV(USER, 0), 'leverage', '5', 'isCross', 'false');
    await r.hset(KEYS.MARKET_CTX('XMR'), 'markPx', '101', 'markTs', String(Date.now()));
    await (new OrderMatcher(bus) as any).executeFill(order({ oid: 1 }), '100');
    expect((await r.hgetall(KEYS.USER_POS(USER, 0))).marginAlloc).toBe('202');
  });

  it('legacy positions (no marginAlloc) fall back to the entry-price allocation', () => {
    expect(isolatedMarginOf({ szi: '20', entryPx: '558.57' }, 10)).toBe('1117.14');
    expect(isolatedMarginOf({ szi: '20', entryPx: '558.57', rawUsd: '50' }, 10)).toBe('1167.14');
  });
});

// ── 3. Liquidation writes what HL writes ──────────────────────────────────

describe('market liquidation (equity < maintenance, ≥ 2/3 of it)', () => {
  it('the incident: XMR 20 @ 558.57 isolated 10x, mark 558.545 → a "Close Long" fill, trader keeps the rest', async () => {
    await r.hset(KEYS.USER_ACCOUNT(USER), 'balance', '10000');
    await r.hset(KEYS.USER_LEV(USER, 0), 'leverage', '10', 'isCross', 'false');
    await seedPosition(USER, 0, 'XMR', { szi: '20', entryPx: '558.57' });
    await r.hset(KEYS.MARKET_MIDS, 'XMR', '558.545');

    const check = await checkLiquidation(USER, 0);
    // equity = 1117.14 (entry-price margin) − 0.50 = 1116.64 ; maintenance = 20 × 558.545 × (1/5)/2 = 1117.09
    expect(check).toMatchObject({ shouldLiquidate: true, accountEquity: '1116.64', maintenanceMargin: '1117.09' });

    await checkAndLiquidateUser(USER);
    const [fill] = await fills();
    const fee = D('20').times('558.545').times('0.00045');
    expect(fill).toMatchObject({
      coin: 'XMR', px: '558.545', sz: '20', side: 'A', startPosition: '20', dir: 'Close Long',
      closedPnl: '-0.5', crossed: true, fee: fee.toString(),
      liquidation: { liquidatedUser: USER, markPx: '558.545', method: 'market' },
    });
    // key order as HL emits it: … tid, liquidation, …
    const keys = Object.keys(fill);
    expect(keys.indexOf('liquidation')).toBe(keys.indexOf('tid') + 1);
    expect(D(await bal()).toString()).toBe(D('10000').minus('0.5').minus(fee).toString()); // NOT +1116.59
    expect(await r.hgetall(KEYS.USER_POS(USER, 0))).toEqual({});
    expect(await r.hget(VAULT_KEY, 'totalCollected')).toBeNull(); // market: vault gets nothing
    expect(events.liquidationOrder[0].order).toMatchObject({ oid: fill.oid, status: 'filled', reduceOnly: true });
    expect(events.fill).toEqual([{ userId: USER, fill }]);
    expect(events.liquidationLedger).toEqual([]);
  });

  it('walks the real L2 book (bids for a long), not the mark', async () => {
    await r.hset(KEYS.USER_ACCOUNT(USER), 'balance', '1000');
    await r.hset(KEYS.USER_LEV(USER, 0), 'leverage', '5', 'isCross', 'false');
    // At 5x on a 5x asset, margin 200 vs maint ≈ 100 leaves no market-liquidation band before
    // backstop, so the position's margin is cut to 100 with rawUsd −100 (margin removed).
    await seedPosition(USER, 0, 'XMR', { szi: '10', entryPx: '100', marginAlloc: '200', rawUsd: '-100' });
    await r.hset(KEYS.MARKET_MIDS, 'XMR', '99'); // equity 100 − 10 = 90 ; maint 99 ; 2/3 = 66 → market
    getL2Book.mockResolvedValue({ coin: 'XMR', levels: [[{ px: '98.9', sz: '4', n: 1 }, { px: '98.8', sz: '100', n: 1 }], [{ px: '99.1', sz: '5', n: 1 }]] });
    await checkAndLiquidateUser(USER);
    const [fill] = await fills();
    expect(getL2Book).toHaveBeenCalledWith('XMR');
    expect(fill.px).toBe(D('4').times('98.9').plus(D('6').times('98.8')).div('10').toString()); // VWAP 98.84
    expect(fill.liquidation.markPx).toBe('99');
  });
});

describe('backstop liquidation (equity < 2/3 of maintenance)', () => {
  it('isolated: "Liquidated Isolated Long" fill, fee 0, balance down by EXACTLY the margin, equity to the vault, ledger + userEvents', async () => {
    await r.hset(KEYS.USER_ACCOUNT(USER), 'balance', '1000');
    await r.hset(KEYS.USER_LEV(USER, 0), 'leverage', '5', 'isCross', 'false');
    await seedPosition(USER, 0, 'XMR', { szi: '10', entryPx: '100', marginAlloc: '200' });
    await r.hset(KEYS.MARKET_MIDS, 'XMR', '81'); // equity 200 − 190 = 10 ; maint 81 ; 10 < 54 → backstop

    expect(await executeLiquidation(USER, 0)).toBe(true);
    const [fill] = await fills();
    expect(fill).toMatchObject({ dir: 'Liquidated Isolated Long', px: '81', fee: '0', closedPnl: '-190',
      liquidation: { liquidatedUser: USER, markPx: '81', method: 'backstop' } });
    expect(D(await bal()).toString()).toBe('800');                                         // 1000 − 200 margin
    expect(await r.hget(VAULT_KEY, 'totalCollected')).toBe('10');    // remaining equity
    expect(events.liquidationLedger[0]).toMatchObject({ userId: USER, delta: {
      type: 'liquidation', liquidatedNtlPos: '810', accountValue: '10', leverageType: 'Isolated',
      liquidatedPositions: [{ coin: 'XMR', szi: '10' }],
    } });
    expect(events.liquidationEvent[0]).toEqual({ userId: USER, liquidation: {
      lid: fill.tid, liquidator: '0x410Ce828C9EcD89ae9Ad9Bab89ec98036C7f07a4', liquidated_user: USER,
      liquidated_ntl_pos: '810', liquidated_account_value: '10',
    } });
  });

  it('isolated with equity below zero: the trader still loses only the margin (the vault eats the rest)', async () => {
    await r.hset(KEYS.USER_ACCOUNT(USER), 'balance', '1000');
    await r.hset(KEYS.USER_LEV(USER, 0), 'leverage', '5', 'isCross', 'false');
    await seedPosition(USER, 0, 'XMR', { szi: '10', entryPx: '100', marginAlloc: '200' });
    await r.hset(KEYS.MARKET_MIDS, 'XMR', '70'); // equity 200 − 300 = −100
    await checkAndLiquidateUser(USER);
    expect(D(await bal()).toString()).toBe('800');
    expect(await r.hget(VAULT_KEY, 'totalCollected')).toBeNull();
  });

  it('cross: every cross position goes, cross equity ends at zero, isolated margin is left alone', async () => {
    await r.hset(KEYS.USER_ACCOUNT(USER), 'balance', '1300');
    await r.hset(KEYS.USER_LEV(USER, 0), 'leverage', '5', 'isCross', 'true');
    await r.hset(KEYS.USER_LEV(USER, 1), 'leverage', '5', 'isCross', 'false');
    await seedPosition(USER, 0, 'XMR', { szi: '10', entryPx: '100' });              // cross
    await seedPosition(USER, 1, 'BTC', { szi: '1', entryPx: '1000', marginAlloc: '200' }); // isolated, healthy
    await r.hset(KEYS.MARKET_MIDS, 'XMR', '20', 'BTC', '1000');
    // cross value = 1300 − 200 (isolated margin) − 800 (XMR pnl) = 300 ; cross maint = 10 × 20 × 0.1 = 20 → safe
    await checkAndLiquidateUser(USER);
    expect(await fills()).toEqual([]);
    await r.hset(KEYS.MARKET_MIDS, 'XMR', '10.05');
    await r.hset(KEYS.USER_ACCOUNT(USER), 'balance', '1105');
    // cross value = 1105 − 200 − 899.5 = 5.5 ; maint = 10.05 ; 5.5 < 2/3 × 10.05 = 6.7 → backstop
    await checkAndLiquidateUser(USER);
    const [fill] = await fills();
    expect(fill).toMatchObject({ coin: 'XMR', dir: 'Liquidated Cross Long', fee: '0' });
    expect(D(await bal()).toString()).toBe('200');                                  // = the isolated margin: cross equity 0
    expect(await r.hgetall(KEYS.USER_POS(USER, 1))).toMatchObject({ szi: '1' });   // isolated untouched
    expect(events.liquidationLedger[0].delta.leverageType).toBe('Cross');
  });
});

describe('cross is checked as one account', () => {
  it('two cross positions each under their own maintenance but over the SUM are both liquidated', async () => {
    await r.hset(KEYS.USER_ACCOUNT(USER), 'balance', '80');
    await r.hset(KEYS.USER_LEV(USER, 0), 'leverage', '5', 'isCross', 'true');
    await r.hset(KEYS.USER_LEV(USER, 3), 'leverage', '5', 'isCross', 'true');
    await r.set(KEYS.MARKET_META, JSON.stringify({ ...META, universe: [...META.universe, { name: 'ZZZ', szDecimals: 2, maxLeverage: 5 }] }));
    await seedPosition(USER, 0, 'XMR', { szi: '5', entryPx: '100' });
    await seedPosition(USER, 3, 'ZZZ', { szi: '5', entryPx: '100' });
    await r.hset(KEYS.MARKET_MIDS, 'XMR', '100', 'ZZZ', '100');
    // each maint 50 < cross value 80 (the old per-position check passed), sum 100 > 80 → liquidate (80 ≥ 66.7 → market)
    expect(await checkLiquidation(USER, 0)).toMatchObject({ shouldLiquidate: true, accountEquity: '80', maintenanceMargin: '100' });
    await checkAndLiquidateUser(USER);
    expect((await fills()).map((f) => [f.coin, f.dir, f.liquidation.method]).sort()).toEqual([
      ['XMR', 'Close Long', 'market'], ['ZZZ', 'Close Long', 'market'],
    ]);
  });
});

describe('HIP-3 dexes are liquidated too', () => {
  it('checkAndLiquidateAll visits the xyz account and books against balance:xyz', async () => {
    await r.set(KEYS.MARKET_PERPDEXS, JSON.stringify([null, { name: 'xyz' }]));
    await r.set(KEYS.MARKET_META_DEX('xyz'), JSON.stringify({ universe: [{ name: 'xyz:AAPL', szDecimals: 2, maxLeverage: 10 }] }));
    await r.hset(KEYS.USER_ACCOUNT(USER), 'balance', '5000', 'balance:xyz', '10');
    await r.hset(KEYS.USER_LEV(USER, 110_000), 'leverage', '10', 'isCross', 'true');
    await seedPosition(USER, 110_000, 'xyz:AAPL', { szi: '10', entryPx: '200' }, 'xyz');
    await r.hset(KEYS.MARKET_MIDS, 'xyz:AAPL', '199.5'); // cross value 10 − 5 = 5 < maint 99.75 → backstop
    await checkAndLiquidateAll();
    const [fill] = await fills();
    expect(fill).toMatchObject({ coin: 'xyz:AAPL', dir: 'Liquidated Cross Long' });
    expect(D(await bal(USER, 'balance:xyz')).toString()).toBe('0');
    expect(D(await bal()).toString()).toBe('5000');                                 // native account untouched
    expect(events.accountUpdate.at(-1)).toEqual({ userId: USER, dexes: ['xyz'] });
  });
});

describe('partial liquidation above 100k USDC', () => {
  beforeEach(async () => {
    await r.hset(KEYS.USER_LEV(USER, 0), 'leverage', '5', 'isCross', 'true');
    await seedPosition(USER, 0, 'XMR', { szi: '2000', entryPx: '100' }); // 200k notional
    await r.hset(KEYS.MARKET_MIDS, 'XMR', '100');
    await r.hset(KEYS.USER_ACCOUNT(USER), 'balance', '18000');          // < maint 20000, > 2/3 → market
  });

  it('only 20% goes first; during the 30 s cooldown the next liquidation takes the whole position', async () => {
    await checkAndLiquidateUser(USER);
    expect((await fills()).map((f) => f.sz)).toEqual(['400']);
    expect(await r.hget(KEYS.USER_POS(USER, 0), 'szi')).toBe('1600');
    await r.hset(KEYS.MARKET_MIDS, 'XMR', '98');                       // still liquidatable
    await checkAndLiquidateUser(USER);
    expect((await fills()).map((f) => f.sz)).toEqual(['1600', '400']);
    expect(await r.hgetall(KEYS.USER_POS(USER, 0))).toEqual({});
  });

  it('after the cooldown expires a fresh liquidation is partial again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await checkAndLiquidateUser(USER);
    vi.setSystemTime(Date.now() + 30_001);
    await r.hset(KEYS.MARKET_MIDS, 'XMR', '98');
    await checkAndLiquidateUser(USER);
    expect((await fills()).map((f) => f.sz)).toEqual(['320', '400']);   // 20% of the remaining 1600
  });
});

// ── 4. Display ↔ trigger agree on the liquidation price ───────────────────

describe('the displayed isolated liquidation price is where the engine liquidates', () => {
  it.each([
    ['long, single tier', '10', '100', 10],
    ['long crossing into the 5x tier (notional 1000)', '12', '100', 10],
    ['short', '-10', '100', 10],
  ])('%s', async (_n, szi, entryPx, lev) => {
    const tiers = META.marginTables[0][1] as any;
    const margin = isolatedMarginOf({ szi, entryPx }, lev);
    const liq = calculateLiquidationPrice(szi, entryPx, '0', lev, false, margin, tiers.marginTiers)!;
    await r.hset(KEYS.USER_LEV(USER, 2), 'leverage', String(lev), 'isCross', 'false');
    await seedPosition(USER, 2, 'TIER', { szi, entryPx });
    const isLong = Number(szi) > 0;
    const beyond = D(liq).times(isLong ? '0.99999' : '1.00001').toString();
    const inside = D(liq).times(isLong ? '1.00001' : '0.99999').toString();
    await r.hset(KEYS.MARKET_MIDS, 'TIER', inside);
    expect((await checkLiquidation(USER, 2)).shouldLiquidate).toBe(false);
    await r.hset(KEYS.MARKET_MIDS, 'TIER', beyond);
    expect((await checkLiquidation(USER, 2)).shouldLiquidate).toBe(true);
  });
});

// ── 5. Concurrency + scan index ───────────────────────────────────────────

describe('per-user lock', () => {
  it('serializes one user, never blocks another, and is reentrant', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withUserLock('a', async () => { order.push('a1 start'); await new Promise<void>((res) => { releaseFirst = res; }); order.push('a1 end'); });
    const second = withUserLock('a', async () => { order.push('a2'); });
    const other = withUserLock('b', async () => { order.push('b'); });
    await other;
    expect(order).toEqual(['a1 start', 'b']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['a1 start', 'b', 'a1 end', 'a2']);
    expect(await withUserLock('a', () => withUserLock('a', async () => 'nested'))).toBe('nested');
  });

  it('a fill queued behind a liquidation sees the liquidated (empty) position, not a stale one', async () => {
    await r.hset(KEYS.USER_ACCOUNT(USER), 'balance', '1000');
    await r.hset(KEYS.USER_LEV(USER, 0), 'leverage', '5', 'isCross', 'false');
    await seedPosition(USER, 0, 'XMR', { szi: '10', entryPx: '100', marginAlloc: '200' });
    await r.hset(KEYS.MARKET_MIDS, 'XMR', '81');
    const m = new OrderMatcher(bus);
    const closeOrder = { oid: 99, userId: USER, asset: 0, coin: 'XMR', isBuy: false, sz: '10', limitPx: '81', orderType: 'limit',
      tif: 'Gtc', reduceOnly: true, grouping: 'na', status: 'open', filledSz: '0', avgPx: '0', createdAt: 1, updatedAt: 1 } as any;
    await Promise.all([executeLiquidation(USER, 0), (m as any).executeFill(closeOrder, '81')]);
    // The reduce-only fill found no position to reduce: exactly one close, no resurrected/negative position.
    expect((await fills()).length).toBe(1);
    expect(await r.hgetall(KEYS.USER_POS(USER, 0))).toEqual({});
  });
});

describe('position holder index', () => {
  it('backfills pre-existing positions and prunes emptied accounts', async () => {
    await r.sadd(KEYS.USERS_ACTIVE, USER, '0xflat');
    await r.sadd(KEYS.USER_POSITIONS_SCOPED(USER, ''), '0');
    await r.hset(KEYS.USER_POS(USER, 0), 'coin', 'XMR', 'szi', '1', 'entryPx', '1');
    expect(await backfillPositionHolders()).toBe(1);
    expect(await r.smembers(KEYS.POSITION_HOLDERS)).toEqual([`${USER}|`]);
    expect([...(await positionCoins())]).toEqual(['XMR']);
    await r.srem(KEYS.USER_POSITIONS_SCOPED(USER, ''), '0');
    await checkAndLiquidateAll();
    expect(await r.smembers(KEYS.POSITION_HOLDERS)).toEqual([]);
  });
});
