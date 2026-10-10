/**
 * `orderUpdates` and `userFills` subscriptions must be matched case-insensitively on the user address: events are
 * broadcast to the LOWERCASED user id, while wallet libraries (viem's account.address, ethers) hand out CHECKSUMMED
 * addresses. Before the fix a checksummed subscriber silently received nothing on these two channels.
 *
 * Real HyPaperWsServer + real `ws` client over a real socket; only storage / engine reads are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

vi.mock('../store/redis.js', async () => {
  const { RedisMock } = await import('./helpers/redis-mock.js');
  return { redis: new RedisMock() };
});
vi.mock('../config.js', () => ({ config: { LOG_LEVEL: 'silent', HL_API_URL: 'https://hl.test' } }));
vi.mock('../api/server.js', () => ({ app: { request: async () => new Response('{}') } }));
vi.mock('../engine/position.js', () => ({
  getClearinghouseState: vi.fn(async () => ({ marginSummary: {}, assetPositions: [] })),
  getFrontendOpenOrders: vi.fn(async () => []),
}));
vi.mock('../engine/fill.js', () => ({ getUserFills: vi.fn(async () => []) }));
vi.mock('../engine/account.js', () => ({ getActiveAssetData: vi.fn(async () => ({})) }));
vi.mock('../store/pg-queries.js', () => ({
  getUserFundingPg: vi.fn(async () => []),
  getLedgerUpdatesPg: vi.fn(async () => []),
}));

const { HyPaperWsServer } = await import('../ws/server.js');

// A real EIP-55 checksummed address and its lowercase form (what the engine stores / broadcasts as `userId`).
const CHECKSUMMED = '0xDEA69739164a3864A1950426bEc319863c02048F';
const LOWER = CHECKSUMMED.toLowerCase();

let httpServer: Server;
let bus: EventEmitter;
let url: string;

beforeAll(async () => {
  httpServer = createServer();
  bus = new EventEmitter();
  new HyPaperWsServer(httpServer, bus, { ensureUpstreamMarketSub: () => {} });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}/ws`;
});
afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
});

/** Connect, subscribe, wait for the subscriptionResponse, and collect every later message. */
async function subscribe(subscription: Record<string, unknown>): Promise<{ frames: any[]; ws: WebSocket }> {
  const ws = new WebSocket(url);
  const frames: any[] = [];
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  const acked = new Promise<void>((resolve) => {
    ws.on('message', (m) => {
      const j = JSON.parse(m.toString());
      if (j.channel === 'subscriptionResponse') resolve();
      else frames.push(j);
    });
  });
  ws.send(JSON.stringify({ method: 'subscribe', subscription }));
  await acked;
  await new Promise((r) => setTimeout(r, 30)); // let the (async) snapshot frames land before the test emits
  frames.length = 0;
  return { frames, ws };
}
const settle = () => new Promise((r) => setTimeout(r, 60));

const order = (oid: number) => ({
  oid, userId: LOWER, asset: 0, coin: 'BTC', isBuy: false, sz: '0.01', limitPx: '100', orderType: 'limit', tif: 'Gtc',
  reduceOnly: false, grouping: 'na', status: 'cancelled', filledSz: '0', avgPx: '0', createdAt: 10, updatedAt: 20,
});

describe('checksummed-address subscribers receive user-channel frames', () => {
  it('orderUpdates', async () => {
    const { frames, ws } = await subscribe({ type: 'orderUpdates', user: CHECKSUMMED });
    bus.emit('orderUpdate', { userId: LOWER, order: order(11), status: 'cancelled' });
    await settle();
    ws.close();
    const ou = frames.filter((f) => f.channel === 'orderUpdates');
    expect(ou).toHaveLength(1);
    expect(ou[0].data[0].order.oid).toBe(11);
    expect(ou[0].data[0].status).toBe('cancelled'); // (normal orders keep HyPaper's existing spelling — unrelated gap)
  });

  it('orderUpdates (batched frame)', async () => {
    const { frames, ws } = await subscribe({ type: 'orderUpdates', user: CHECKSUMMED });
    bus.emit('orderUpdateBatch', { userId: LOWER, updates: [{ order: order(21), status: 'open' }, { order: order(22), status: 'cancelled' }] });
    await settle();
    ws.close();
    expect(frames.filter((f) => f.channel === 'orderUpdates')[0].data.map((e: any) => e.order.oid)).toEqual([21, 22]);
  });

  it('userFills (live fill frame, after the snapshot)', async () => {
    const { frames, ws } = await subscribe({ type: 'userFills', user: CHECKSUMMED });
    bus.emit('fill', { userId: LOWER, fill: { coin: 'BTC', px: '100', sz: '0.01', side: 'B', time: 1, oid: 5, tid: 9 } });
    await settle();
    ws.close();
    const uf = frames.filter((f) => f.channel === 'userFills');
    expect(uf).toHaveLength(1);
    expect(uf[0].data.isSnapshot).toBe(false);
    expect(uf[0].data.fills[0].oid).toBe(5);
  });

  it('lowercase and mixed-case subscribers both still work, and a different user receives nothing', async () => {
    const a = await subscribe({ type: 'orderUpdates', user: LOWER });
    const b = await subscribe({ type: 'orderUpdates', user: CHECKSUMMED });
    const other = await subscribe({ type: 'orderUpdates', user: '0x1111111111111111111111111111111111111111' });
    bus.emit('orderUpdate', { userId: LOWER, order: order(31), status: 'open' });
    await settle();
    for (const s of [a, b, other]) s.ws.close();
    expect(a.frames.filter((f) => f.channel === 'orderUpdates')).toHaveLength(1);
    expect(b.frames.filter((f) => f.channel === 'orderUpdates')).toHaveLength(1);
    expect(other.frames.filter((f) => f.channel === 'orderUpdates')).toHaveLength(0);
  });

  it('unsubscribe with the checksummed address removes the lowercase-keyed subscription', async () => {
    const { frames, ws } = await subscribe({ type: 'orderUpdates', user: CHECKSUMMED });
    ws.send(JSON.stringify({ method: 'unsubscribe', subscription: { type: 'orderUpdates', user: CHECKSUMMED } }));
    await settle();
    frames.length = 0;
    bus.emit('orderUpdate', { userId: LOWER, order: order(41), status: 'open' });
    await settle();
    ws.close();
    expect(frames.filter((f) => f.channel === 'orderUpdates')).toHaveLength(0);
  });
});
