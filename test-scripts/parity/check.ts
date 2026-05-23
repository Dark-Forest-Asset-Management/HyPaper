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

import { readFileSync } from 'node:fs';
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

  await hypaper({ type: 'resetAccount', user: W });

  console.log(`\n${hardFails === 0 ? 'PARITY OK — no missing/type-drifted fields' : `${hardFails} hard parity failure(s)`}`);
  process.exit(hardFails === 0 ? 0 : 1);
})();
