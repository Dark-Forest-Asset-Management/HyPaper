/**
 * TMP verification — Epic 1.1 (account-state info parity).
 *
 * Against a running local HyPaper + shared Redis/Postgres, proves each new
 * endpoint is served from PAPER state with HL-matching shape:
 *   - userNonFundingLedgerUpdates: deposit on account creation + setBalance delta
 *   - userFunding: drives FundingWorker once (8h timer otherwise) → persisted row
 *   - portfolio: 8 periods, non-empty history
 *   - userFees / userRateLimit / userRole / activeAssetData: shape vs HL golden
 *
 * Shapes are diffed against scripts/captures/1*.json (HL mainnet goldens).
 * Throwaway — delete after Epic 1.1 sign-off.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { compareToGolden, type Mismatch } from './parity/shape.js';
import { redis } from '../src/store/redis.js';
import { KEYS } from '../src/store/keys.js';
import { connectDb } from '../src/store/db.js';
import { FundingWorker } from '../src/worker/funding-worker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURES = resolve(__dirname, '../scripts/captures');
const BASE = process.argv[2] ?? 'http://localhost:3000';
const W = ('0x' + ethers.hexlify(ethers.randomBytes(20)).slice(2)).toLowerCase();

const golden = (f: string) => JSON.parse(readFileSync(resolve(CAPTURES, f), 'utf8')).response;
const info = (b: object) => fetch(`${BASE}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const hypaper = (b: object) => fetch(`${BASE}/hypaper`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
  ok ? pass++ : fail++;
}
function shapeCheck(name: string, g: unknown, actual: unknown) {
  const mm: Mismatch[] = compareToGolden(g, actual);
  const fails = mm.filter((m) => m.severity === 'fail');
  check(name + ' shape', fails.length === 0, fails.length ? fails.map((m) => `${m.path}: ${m.detail}`).join('; ') : 'matches HL golden');
}

(async () => {
  await connectDb();
  console.log(`HyPaper: ${BASE}   wallet: ${W}\n`);

  // ── ledger: account creation (deposit) + setBalance (delta) ──
  await hypaper({ type: 'getAccountInfo', user: W });          // first touch → initial deposit
  await hypaper({ type: 'setBalance', user: W, balance: 7777 }); // delta vs default → another ledger row
  await sleep(1200);
  const ledger = await info({ type: 'userNonFundingLedgerUpdates', user: W, startTime: 0 });
  check('ledger has deposit rows', Array.isArray(ledger) && ledger.length >= 1 && ledger.some((x: any) => x.delta.type === 'deposit'), `count=${ledger.length}, types=${JSON.stringify(ledger.map((x: any) => x.delta.type))}`);
  const gLedgerDeposit = (golden('11_userNonFundingLedgerUpdates.json') as any[]).find((x) => x.delta.type === 'deposit');
  if (ledger[0]) shapeCheck('userNonFundingLedgerUpdates(deposit)', gLedgerDeposit, ledger.find((x: any) => x.delta.type === 'deposit'));

  // ── userFunding: seed a position + funding ctx, drive the worker once ──
  await redis.sadd(KEYS.USERS_ACTIVE, W);
  await redis.sadd(KEYS.USER_POSITIONS(W), '0');
  await redis.hset(KEYS.USER_POS(W, 0), { szi: '0.1', coin: 'BTC', entryPx: '70000' });
  await redis.hset(KEYS.MARKET_CTX('BTC'), 'funding', '0.0000125', 'markPx', '70000');
  await new FundingWorker().applyFunding();
  await sleep(1200);
  const funding = await info({ type: 'userFunding', user: W, startTime: 0 });
  check('userFunding has a persisted row', Array.isArray(funding) && funding.length >= 1, `count=${funding.length}, first=${JSON.stringify(funding[0])}`);
  if (funding[0]) shapeCheck('userFunding', golden('10_userFunding.json'), funding);

  // ── portfolio ──
  const portfolio = await info({ type: 'portfolio', user: W });
  const names = Array.isArray(portfolio) ? portfolio.map((p: any) => p[0]) : [];
  check('portfolio has 8 HL periods', JSON.stringify(names) === JSON.stringify(['day', 'week', 'month', 'allTime', 'perpDay', 'perpWeek', 'perpMonth', 'perpAllTime']), `names=${JSON.stringify(names)}`);
  const day = portfolio?.[0]?.[1];
  check('portfolio history non-empty', Array.isArray(day?.accountValueHistory) && day.accountValueHistory.length >= 1, `day.accountValueHistory len=${day?.accountValueHistory?.length}`);
  shapeCheck('portfolio', golden('12_portfolio.json'), portfolio);

  // ── userFees / userRateLimit / userRole / activeAssetData ──
  const fees = await info({ type: 'userFees', user: W });
  check('userFees has feeSchedule + rates', !!fees.feeSchedule && typeof fees.userCrossRate === 'string', `keys=${Object.keys(fees).join(',')}`);
  shapeCheck('userFees', golden('13_userFees.json'), fees);

  shapeCheck('userRateLimit', golden('15_userRateLimit.json'), await info({ type: 'userRateLimit', user: W }));

  const role = await info({ type: 'userRole', user: W });
  check('userRole = user', role.role === 'user', JSON.stringify(role));

  const aad = await info({ type: 'activeAssetData', user: W, coin: 'BTC' });
  check('activeAssetData computed', Array.isArray(aad.maxTradeSzs) && Array.isArray(aad.availableToTrade), JSON.stringify(aad));
  shapeCheck('activeAssetData', golden('16_activeAssetData.json'), aad);

  // cleanup shared-state seeds
  await redis.del(KEYS.USER_POS(W, 0));
  await redis.srem(KEYS.USER_POSITIONS(W), '0');
  await redis.srem(KEYS.USERS_ACTIVE, W);

  console.log(`\n${pass} passed, ${fail} failed`);
  await redis.quit();
  process.exit(fail === 0 ? 0 : 1);
})();
