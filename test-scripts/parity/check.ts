/**
 * HL parity runner — the reusable harness for "does HyPaper match HL 1:1".
 *
 * For each locally-served /info endpoint, it:
 *   1. loads a real HL golden response (scripts/captures/*.json — captured
 *      from HL testnet by probe-hl-testnet.ts),
 *   2. builds matching paper state in a running HyPaper (a filled position +
 *      a resting order so the arrays are non-empty),
 *   3. diffs HyPaper's response SHAPE against the golden (field-by-field).
 *
 * FAIL = a field HL emits is missing from HyPaper, or a non-null type drift.
 * WARN = extra HyPaper field / nullability / unverifiable empty array.
 *
 * Each future epic adds a golden capture + a builder step here, so parity is
 * enforced as the surface grows.
 *
 * Usage: npm run parity   (or: npx tsx test-scripts/parity/check.ts [baseUrl])
 * Requires: HyPaper running + Redis up.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shapeOf, diffShape, compareToGolden, type Mismatch } from './shape.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURES = resolve(__dirname, '../../scripts/captures');
const BASE = process.argv[2] ?? process.env.HYPAPER_BASE ?? 'http://localhost:3000';
const HL = 'https://api.hyperliquid.xyz';
const W = '0x00000000000000000000000000000000par1ty00';

function golden(file: string): unknown {
  const raw = JSON.parse(readFileSync(resolve(CAPTURES, file), 'utf8'));
  return raw.response ?? raw;
}
async function hl(body: object): Promise<any> {
  return (await fetch(`${HL}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
}
async function info(body: object): Promise<any> {
  return (await fetch(`${BASE}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
}
async function exchange(body: object): Promise<any> {
  return (await fetch(`${BASE}/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
}
async function hypaper(body: object): Promise<any> {
  return (await fetch(`${BASE}/hypaper`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
}

let hardFails = 0;
function report(label: string, mm: Mismatch[]): void {
  const fails = mm.filter((m) => m.severity === 'fail');
  const warns = mm.filter((m) => m.severity === 'warn');
  console.log(`\n── ${label} ──  ${fails.length ? `${fails.length} FAIL` : 'shape OK'}${warns.length ? `, ${warns.length} warn` : ''}`);
  for (const m of fails) console.log(`   FAIL ${m.path} — ${m.detail}`);
  for (const m of warns) console.log(`   warn ${m.path} — ${m.detail}`);
  hardFails += fails.length;
}

(async () => {
  // ── 0. self-test the util (sign of life) ──────────────────────────────
  {
    const g = golden('09_clearinghouseState.json');
    const self = diffShape(shapeOf(g), shapeOf(g));
    const mutated = JSON.parse(JSON.stringify(g));
    delete mutated.withdrawable;
    const detect = diffShape(shapeOf(g), shapeOf(mutated)).filter((m) => m.severity === 'fail');
    const ok = self.length === 0 && detect.some((m) => m.path.includes('withdrawable'));
    console.log(`util self-test: ${ok ? 'PASS' : 'FAIL'} (self=${self.length} mismatches, mutation detected=${detect.length})`);
    if (!ok) { hardFails++; }
  }

  // ── 1. build paper state ──────────────────────────────────────────────
  const meta = await hl({ type: 'meta' });
  const btc = meta.universe.findIndex((u: any) => u.name === 'BTC');
  const mids = await info({ type: 'allMids' });
  const mid = Number(mids.BTC ?? 70000);
  console.log(`BTC asset=${btc} mid=${mid}`);

  await hypaper({ type: 'resetAccount', user: W });
  await hypaper({ type: 'setBalance', user: W, balance: 1_000_000 });

  // Filling buy (limit above mid) → opens a position + records a fill.
  await exchange({ wallet: W, action: { type: 'order', grouping: 'na',
    orders: [{ a: btc, b: true, p: (mid * 1.05).toFixed(0), s: '0.01', r: false, t: { limit: { tif: 'Gtc' } } }] } });
  // Resting buy (limit below mid) → a frontendOpenOrders entry.
  await exchange({ wallet: W, action: { type: 'order', grouping: 'na',
    orders: [{ a: btc, b: true, p: (mid * 0.5).toFixed(0), s: '0.01', r: false, t: { limit: { tif: 'Gtc' } } }] } });

  // give pg-sink a moment to persist the fill
  await new Promise((r) => setTimeout(r, 800));

  // ── 2. parity diffs ───────────────────────────────────────────────────
  report('clearinghouseState', compareToGolden(golden('09_clearinghouseState.json'), await info({ type: 'clearinghouseState', user: W })));
  report('frontendOpenOrders', compareToGolden(golden('06_openOrders.json'), await info({ type: 'frontendOpenOrders', user: W })));
  report('userFills', compareToGolden(golden('07_userFills.json'), await info({ type: 'userFills', user: W })));

  // ── Phase 1.1 account-state endpoints ──
  // setBalance above (1_000_000) + first-touch deposit produced ledger rows.
  const ledger = await info({ type: 'userNonFundingLedgerUpdates', user: W, startTime: 0 });
  const gLedgerDeposit = (golden('11_userNonFundingLedgerUpdates.json') as any[]).find((x) => x.delta.type === 'deposit');
  const ledgerDeposit = Array.isArray(ledger) ? ledger.find((x: any) => x.delta?.type === 'deposit') : undefined;
  report('userNonFundingLedgerUpdates(deposit)', compareToGolden(gLedgerDeposit, ledgerDeposit ?? {}));
  report('portfolio', compareToGolden(golden('12_portfolio.json'), await info({ type: 'portfolio', user: W })));
  report('userFees', compareToGolden(golden('13_userFees.json'), await info({ type: 'userFees', user: W })));
  report('userRateLimit', compareToGolden(golden('15_userRateLimit.json'), await info({ type: 'userRateLimit', user: W })));
  report('userRole', compareToGolden(golden('14_userRole.json'), await info({ type: 'userRole', user: W })));
  report('activeAssetData', compareToGolden(golden('16_activeAssetData.json'), await info({ type: 'activeAssetData', user: W, coin: 'BTC' })));
  // userFunding requires the funding worker to fire (8h cadence) — covered by
  // test-scripts/tmp-epic-1.1-account-state.ts which drives it directly.

  // ── Trailing stops (HL testnet captures 30_* / 33_*) ──────────────────────
  // Place a close-long trailing stop, then orphan it by closing the position, and diff HyPaper's responses against the
  // real HL ones. Uses HyPaper's OWN universe for the BTC asset id (the mainnet index above can differ on testnet).
  if (existsSync(resolve(CAPTURES, '30_trailing_v1_close_px.json')) && existsSync(resolve(CAPTURES, '33_orphan_o1_after_close_snapshots.json'))) {
    const raw = (f: string) => JSON.parse(readFileSync(resolve(CAPTURES, f), 'utf8'));
    const hpMeta = await info({ type: 'meta' });
    const tAsset = hpMeta.universe.findIndex((u: any) => u.name === 'BTC');
    const tMids = await info({ type: 'allMids' });
    const tMid = Number(tMids.BTC ?? mid);
    if (tAsset < 0) {
      console.log('\n── trailing stops ──  SKIPPED (BTC not in HyPaper universe)');
    } else {
      await hypaper({ type: 'resetAccount', user: W });
      await hypaper({ type: 'setBalance', user: W, balance: 1_000_000 });
      const sz = '0.01';
      const filled = await exchange({ wallet: W, action: { type: 'order', grouping: 'na',
        orders: [{ a: tAsset, b: true, p: (tMid * 1.05).toFixed(0), s: sz, r: false, t: { limit: { tif: 'Ioc' } } }] } });
      const placed = await exchange({ wallet: W, action: { type: 'trailingStop', asset: tAsset, isBuy: false, sz, reduceOnly: true,
        retracement: { px: '3000' }, activationPx: null } });
      const oid = placed?.response?.data?.oid;
      if (!filled?.response?.data?.statuses?.[0]?.filled || !Number.isInteger(oid)) {
        console.log('\n── trailing stops ──  FAIL could not set up: ' + JSON.stringify({ filled, placed }));
        hardFails++;
      } else {
        const g1 = raw('30_trailing_v1_close_px.json');
        const gOid = g1.response.response.data.oid;
        report('trailingStop /exchange response', compareToGolden(g1.response, placed));
        report('trailingStop frontendOpenOrders row', compareToGolden(g1.followUps.frontendOpenOrders.find((o: any) => o.oid === gOid),
          (await info({ type: 'frontendOpenOrders', user: W })).find((o: any) => o.oid === oid) ?? {}));
        report('trailingStop openOrders row', compareToGolden(g1.followUps.openOrders.find((o: any) => o.oid === gOid),
          (await info({ type: 'openOrders', user: W })).find((o: any) => o.oid === oid) ?? {}));
        report('trailingStop orderStatus (open)', compareToGolden(g1.followUps.orderStatus, await info({ type: 'orderStatus', user: W, oid })));

        // Orphan: close the position under the stop with a normal reduce-only IOC.
        await exchange({ wallet: W, action: { type: 'order', grouping: 'na',
          orders: [{ a: tAsset, b: false, p: (tMid * 0.95).toFixed(0), s: sz, r: true, t: { limit: { tif: 'Ioc' } } }] } });
        await new Promise((r) => setTimeout(r, 1200));   // pg-sink persists the history rows asynchronously
        const go = raw('33_orphan_o1_after_close_snapshots.json').after_0s;
        report('trailingStop orderStatus (reduceOnlyCanceled)', compareToGolden(go.orderStatus, await info({ type: 'orderStatus', user: W, oid })));
        const hist = (await info({ type: 'historicalOrders', user: W })).filter((h: any) => h.order.oid === oid);
        const names = hist.map((h: any) => h.status).join(',');
        if (names !== 'reduceOnlyCanceled,open') {
          console.log(`\n── trailingStop historicalOrders ──  FAIL expected [reduceOnlyCanceled,open], got [${names}]`);
          hardFails++;
        } else {
          for (const h of go.historicalOrdersForOid) {
            report(`trailingStop historicalOrders row (${h.status})`, compareToGolden(h, hist.find((x: any) => x.status === h.status) ?? {}));
          }
        }
      }
    }
  }

  await hypaper({ type: 'resetAccount', user: W });

  console.log(`\n${hardFails === 0 ? 'PARITY OK — no missing/type-drifted fields' : `${hardFails} hard parity failure(s)`}`);
  process.exit(hardFails === 0 ? 0 : 1);
})();
