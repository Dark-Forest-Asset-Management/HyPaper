import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RedisMock } from './helpers/redis-mock.js';

const here = dirname(fileURLToPath(import.meta.url));
const frames = JSON.parse(readFileSync(resolve(here, 'fixtures/trailing/trailing-ws-entries.json'), 'utf8'));

const redisMock = new RedisMock();
vi.mock('../store/redis.js', () => ({ redis: redisMock }));
vi.mock('../config.js', () => ({ config: { LOG_LEVEL: 'silent', HL_API_URL: 'https://hl.test' } }));

// ── a stub drizzle `db`: select().from(t).where().orderBy().limit() resolves to per-table rows ──
const tableRows = new Map<unknown, unknown[]>();
const inserts: Array<{ table: unknown; values: any }> = [];
const mockDb = {
  select: () => ({
    from: (table: unknown) => {
      const b: any = {
        where: () => b,
        orderBy: () => b,
        limit: () => Promise.resolve(tableRows.get(table) ?? []),
      };
      return b;
    },
  }),
  insert: (table: unknown) => ({
    values: (values: any) => {
      inserts.push({ table, values });
      return { onConflictDoNothing: () => Promise.resolve(), onConflictDoUpdate: () => Promise.resolve() };
    },
  }),
  execute: vi.fn(async () => [{ max: 0 }]),
};
vi.mock('../store/db.js', () => ({ db: mockDb }));

const { shapeOrderUpdate } = await import('../ws/order-updates.js');
const { getHistoricalOrdersPg } = await import('../store/pg-queries.js');
const { startPgSink } = await import('../store/pg-sink.js');
const { orders, orderStatusEvents } = await import('../store/schema.js');
const { D } = await import('../utils/math.js');

/** Rebuild the PaperOrder the engine would hand to the WS layer for one captured HL entry. */
function paperFrom(entry: any, placedAt: number) {
  return {
    oid: entry.order.oid, userId: '0xu', asset: 3, coin: entry.order.coin, isBuy: entry.order.side === 'B',
    sz: entry.order.origSz,
    limitPx: String(parseFloat(entry.order.limitPx)), // engine stores "74480", HL prints "74480.0"
    orderType: 'trailingStop' as const, tif: 'Gtc' as const, reduceOnly: entry.order.reduceOnly === true,
    // a `filled` entry's sz is the UNFILLED REMAINDER, so the engine's filledSz = origSz − that
    grouping: 'na' as const, status: 'open' as const,
    filledSz: entry.status === 'filled' ? D(entry.order.origSz).minus(entry.order.sz).toFixed() : '0', avgPx: '0',
    createdAt: placedAt, updatedAt: entry.statusTimestamp,
  };
}

describe('orderUpdates entries for trailing stops are byte-identical to what HL sent', () => {
  for (const [name, entries] of Object.entries<any[]>(frames).filter(([k]) => !k.startsWith('_'))) {
    it(`${name}: every captured entry is reproduced exactly (key order included)`, () => {
      const placedAt = entries[0].order.timestamp;
      for (const entry of entries) {
        // The engine's bus says 'cancelled'; HL's WS says 'canceled'.
        const busStatus = entry.status === 'canceled' ? 'cancelled' : entry.status;
        const shaped = shapeOrderUpdate(paperFrom(entry, placedAt), busStatus);
        expect(JSON.stringify(shaped)).toBe(JSON.stringify(entry));
      }
    });
  }

  it('normal (non-trailing) orders keep HyPaper\'s existing shape untouched', () => {
    const shaped = shapeOrderUpdate({
      oid: 5, userId: 'u', asset: 0, coin: 'BTC', isBuy: true, sz: '1', limitPx: '100', orderType: 'limit', tif: 'Gtc',
      reduceOnly: false, grouping: 'na', status: 'cancelled', filledSz: '0', avgPx: '0', createdAt: 10, updatedAt: 20, cloid: '0xabc',
    } as any, 'cancelled');
    expect(shaped).toEqual({
      order: { coin: 'BTC', side: 'B', limitPx: '100', sz: '1', oid: 5, timestamp: 10, origSz: '1', cloid: '0xabc' },
      status: 'cancelled', statusTimestamp: 20,
    });
  });
});

describe('historicalOrders merges trailing status events with normal orders', () => {
  beforeEach(() => { tableRows.clear(); });

  const body = (over: Record<string, unknown>) => ({
    coin: 'BTC', side: 'A', limitPx: '74480.0', sz: '0.00015', oid: 7, timestamp: 1000, triggerCondition: 'x', isTrigger: true,
    triggerPx: '82755.2', children: [], isPositionTpsl: false, reduceOnly: true, orderType: 'Trailing Stop Market',
    origSz: '0.00015', tif: null, cloid: null, ...over,
  });

  it('a fired stop yields THREE rows in HL order (filled, triggered, open) next to normal rows, newest first', async () => {
    // events arrive from SQL already ordered (status_timestamp desc, id desc): filled has the higher id.
    tableRows.set(orderStatusEvents, [
      { id: 3, oid: 7, userId: 'u', status: 'filled', statusTimestamp: 2000, body: body({ sz: '0.0', triggerCondition: 'Triggered', isTrigger: false, triggerPx: '0.0', tif: 'Gtc', timestamp: 2000 }) },
      { id: 2, oid: 7, userId: 'u', status: 'triggered', statusTimestamp: 2000, body: body({ triggerCondition: 'frozen at trigger' }) },
      { id: 1, oid: 7, userId: 'u', status: 'open', statusTimestamp: 1000, body: body({ triggerCondition: 'frozen at placement' }) },
    ]);
    tableRows.set(orders, [
      { oid: 9, cloid: null, userId: 'u', asset: 0, coin: 'BTC', isBuy: true, sz: '1', limitPx: '100', orderType: 'limit', tif: 'Gtc', reduceOnly: false,
        triggerPx: null, tpsl: null, isMarket: null, grouping: 'na', status: 'filled', filledSz: '1', avgPx: '100', createdAt: 1500, updatedAt: 1500 },
    ]);

    const rows = await getHistoricalOrdersPg('u');
    expect(rows.map((r) => [r.order.oid, r.status, r.statusTimestamp])).toEqual([
      [7, 'filled', 2000], [7, 'triggered', 2000], [9, 'filled', 1500], [7, 'open', 1000],
    ]);
    // frozen bodies come through untouched
    expect(rows.find((r) => r.status === 'triggered')!.order.triggerCondition).toBe('frozen at trigger');
    expect(rows.find((r) => r.status === 'open')!.order.triggerCondition).toBe('frozen at placement');
  });

  it('an orphaned stop yields [reduceOnlyCanceled, open]', async () => {
    tableRows.set(orderStatusEvents, [
      { id: 2, oid: 7, userId: 'u', status: 'reduceOnlyCanceled', statusTimestamp: 2000, body: body({}) },
      { id: 1, oid: 7, userId: 'u', status: 'open', statusTimestamp: 1000, body: body({}) },
    ]);
    const rows = await getHistoricalOrdersPg('u');
    expect(rows.map((r) => r.status)).toEqual(['reduceOnlyCanceled', 'open']);
  });

  it('respects the limit after merging', async () => {
    tableRows.set(orderStatusEvents, [
      { id: 3, oid: 7, userId: 'u', status: 'filled', statusTimestamp: 3, body: body({}) },
      { id: 2, oid: 7, userId: 'u', status: 'triggered', statusTimestamp: 2, body: body({}) },
      { id: 1, oid: 7, userId: 'u', status: 'open', statusTimestamp: 1, body: body({}) },
    ]);
    expect((await getHistoricalOrdersPg('u', 2)).map((r) => r.status)).toEqual(['filled', 'triggered']);
  });
});

describe('pg-sink persists trailing events', () => {
  beforeEach(() => { inserts.length = 0; });
  const tick = () => new Promise((r) => setTimeout(r, 15));

  it('writes one order_status_events row per trailingHistory event, and every update of a batch to orders', async () => {
    const bus = new EventEmitter();
    startPgSink(bus);
    await tick();
    inserts.length = 0;

    bus.emit('trailingHistory', { userId: 'u', oid: 7, status: 'triggered', statusTimestamp: 2000, body: { oid: 7 } });
    bus.emit('orderUpdateBatch', {
      userId: 'u',
      updates: [
        { status: 'triggered', order: { oid: 7, userId: 'u', asset: 3, coin: 'BTC', isBuy: false, sz: '1', limitPx: '1', orderType: 'trailingStop', tif: 'Gtc', reduceOnly: true, grouping: 'na', status: 'triggered', filledSz: '0', avgPx: '0', createdAt: 1, updatedAt: 2 } },
        { status: 'filled', order: { oid: 7, userId: 'u', asset: 3, coin: 'BTC', isBuy: false, sz: '1', limitPx: '1', orderType: 'trailingStop', tif: 'Gtc', reduceOnly: true, grouping: 'na', status: 'filled', filledSz: '1', avgPx: '5', createdAt: 1, updatedAt: 2 } },
      ],
    });
    await tick();

    const ev = inserts.filter((i) => i.table === orderStatusEvents);
    expect(ev).toHaveLength(1);
    expect(ev[0].values).toMatchObject({ oid: 7, userId: 'u', status: 'triggered', statusTimestamp: 2000, body: { oid: 7 } });
    const ord = inserts.filter((i) => i.table === orders);
    expect(ord.map((i) => i.values.status)).toEqual(['triggered', 'filled']);
    expect(ord[0].values.orderType).toBe('trailingStop');
  });
});
