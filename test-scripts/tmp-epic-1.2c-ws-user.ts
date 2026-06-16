/**
 * TMP verification — Epic 1.2c (WS user feeds from paper state).
 *
 * Proves, against running HyPaper + shared Redis/PG:
 *   SNAPSHOTS on subscribe:
 *     - userFundings: {isSnapshot:true, user, fundings:[{time,coin,usdc,szi,fundingRate,nSamples}]}
 *     - userNonFundingLedgerUpdates: {isSnapshot:true, user, nonFundingLedgerUpdates:[{time,hash,delta}]}
 *     - activeAssetData: {user,coin,leverage,maxTradeSzs,availableToTrade,markPx}
 *   STREAMING (triggered via the server so its emits reach the socket):
 *     - setBalance → userNonFundingLedgerUpdates {isSnapshot:false}
 *     - filling order → userEvents (channel "user") {fills:[…]}
 *
 * Streaming funding shares the exact pg-sink→bus→broadcast path as streaming
 * ledger (verified here), so it's covered structurally.
 *
 * Throwaway — delete after sign-off.
 */
import WebSocket from 'ws';
import { ethers } from 'ethers';
import { redis } from '../src/store/redis.js';
import { KEYS } from '../src/store/keys.js';
import { connectDb } from '../src/store/db.js';
import { FundingWorker } from '../src/worker/funding-worker.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const W = ('0x' + ethers.hexlify(ethers.randomBytes(20)).slice(2)).toLowerCase();

const hypaper = (b: object) => fetch(`${BASE}/hypaper`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const info = (b: object) => fetch(`${BASE}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const exchange = (b: object) => fetch(`${BASE}/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const has = (o: any, ...k: string[]) => o && typeof o === 'object' && k.every((x) => x in o);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`); ok ? pass++ : fail++; };

(async () => {
  await connectDb();
  console.log(`HyPaper: ${BASE}   wallet: ${W}\n`);

  // ── setup: account + ledger + a funding record (via worker drive) ──
  await hypaper({ type: 'getAccountInfo', user: W });
  await hypaper({ type: 'setBalance', user: W, balance: 1_000_000 });
  await redis.sadd(KEYS.USERS_ACTIVE, W);
  await redis.sadd(KEYS.USER_POSITIONS(W), '0');
  await redis.hset(KEYS.USER_POS(W, 0), { szi: '0.1', coin: 'BTC', entryPx: '70000' });
  await redis.hset(KEYS.MARKET_CTX('BTC'), 'funding', '0.0000125', 'markPx', '70000');
  await new FundingWorker().applyFunding();
  await sleep(1200);

  // ── connect + subscribe, collect frames ──
  const frames: any[] = [];
  const ws = new WebSocket(WS_URL);
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  ws.on('message', (raw: WebSocket.RawData) => { try { frames.push(JSON.parse(raw.toString())); } catch {} });
  for (const s of [
    { type: 'userFundings', user: W }, { type: 'userNonFundingLedgerUpdates', user: W },
    { type: 'activeAssetData', user: W, coin: 'BTC' }, { type: 'userEvents', user: W },
  ]) ws.send(JSON.stringify({ method: 'subscribe', subscription: s }));
  await sleep(1500);

  // ── snapshot assertions ──
  const fSnap = frames.find((f) => f.channel === 'userFundings' && f.data?.isSnapshot);
  check('userFundings snapshot', !!fSnap && Array.isArray(fSnap.data.fundings) && fSnap.data.fundings.length >= 1 && has(fSnap.data.fundings[0], 'time', 'coin', 'usdc', 'szi', 'fundingRate', 'nSamples'), JSON.stringify(fSnap?.data?.fundings?.[0] ?? fSnap?.data));
  const lSnap = frames.find((f) => f.channel === 'userNonFundingLedgerUpdates' && f.data?.isSnapshot);
  check('ledger snapshot', !!lSnap && Array.isArray(lSnap.data.nonFundingLedgerUpdates) && lSnap.data.nonFundingLedgerUpdates.length >= 1 && has(lSnap.data.nonFundingLedgerUpdates[0], 'time', 'hash', 'delta'), JSON.stringify(lSnap?.data?.nonFundingLedgerUpdates?.[0] ?? lSnap?.data));
  const aad = frames.find((f) => f.channel === 'activeAssetData');
  check('activeAssetData snapshot', !!aad && has(aad.data, 'user', 'coin', 'leverage', 'maxTradeSzs', 'availableToTrade', 'markPx'), JSON.stringify(aad?.data));

  // ── streaming: ledger via setBalance ──
  frames.length = 0;
  await hypaper({ type: 'setBalance', user: W, balance: 2_000_000 });
  await sleep(1200);
  const lStream = frames.find((f) => f.channel === 'userNonFundingLedgerUpdates' && f.data?.isSnapshot === false);
  check('ledger streaming (setBalance)', !!lStream && Array.isArray(lStream.data.nonFundingLedgerUpdates) && lStream.data.nonFundingLedgerUpdates.length === 1, JSON.stringify(lStream?.data));

  // ── streaming: userEvents fills via a filling order ──
  frames.length = 0;
  const meta = await info({ type: 'meta' });
  const btc = meta.universe.findIndex((u: any) => u.name === 'BTC');
  const mid = Number((await info({ type: 'allMids' })).BTC ?? 70000);
  await exchange({ wallet: W, action: { type: 'order', grouping: 'na', orders: [{ a: btc, b: true, p: (mid * 1.05).toFixed(0), s: '0.001', r: false, t: { limit: { tif: 'Gtc' } } }] } });
  await sleep(1200);
  const ue = frames.find((f) => f.channel === 'user' && f.data?.fills);
  check('userEvents streaming (fill)', !!ue && Array.isArray(ue.data.fills) && ue.data.fills.length >= 1, JSON.stringify(ue?.data?.fills?.[0] ?? ue));

  ws.close();
  await redis.del(KEYS.USER_POS(W, 0));
  await redis.srem(KEYS.USER_POSITIONS(W), '0');
  await redis.srem(KEYS.USERS_ACTIVE, W);
  console.log(`\n${pass} passed, ${fail} failed`);
  await redis.quit();
  process.exit(fail === 0 ? 0 : 1);
})();
