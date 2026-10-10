/**
 * e2e-trailing-stop-restart.ts
 *
 * Real RESTART test of trailing stops against a LOCAL HyPaper (real Redis + Postgres + live testnet marks).
 * Two phases around a server restart that YOU (or the orchestrating shell) perform:
 *
 *   phase PRE   open a BTC long + a SOL long, place a SOL stop A (will be CANCELED after the restart) and a BTC
 *               stop B (will FIRE after the restart); record their state; write a state file; exit.
 *   ... stop the dev server, wait ~30 s, start it again ...
 *   phase POST  load the state file and check, on the restarted server:
 *                 - A and B are still resting (or B already fired — which also proves it kept evaluating)
 *                 - `best` / `triggerPx` RESUMED from the persisted state (best never went backwards) and the
 *                   mark feed is alive again (best within 0.3 % of the live testnet mark)
 *                 - B still FIRES: same oid, taker Close Long fill, history [filled, triggered, open]
 *                   (the `open` row was written BEFORE the restart, so this also proves Postgres persistence)
 *                 - A can still be CANCELED: success, orderStatus canceled, history [canceled, open]
 *
 * Only talks to HYPAPER_BASE (localhost only) + READ-ONLY HL testnet info calls. Throwaway wallet; never touches HL.
 *
 * RUN:  E2E_PHASE=pre  npx tsx scripts/e2e-trailing-stop-restart.ts
 *       (restart the server)
 *       E2E_PHASE=post npx tsx scripts/e2e-trailing-stop-restart.ts
 * ENV:  HYPAPER_BASE=http://localhost:3000  E2E_STATE_FILE=<path>  E2E_FIRE_TIMEOUT_S=240  E2E_SOURCE=b
 * Exit code 0 = all checks passed (SKIPs allowed), 1 = a check failed.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { keccak256, toHex } from 'viem';

const BASE = process.env.HYPAPER_BASE ?? 'http://localhost:3000';
const PHASE = process.env.E2E_PHASE ?? '';
const STATE_FILE = process.env.E2E_STATE_FILE ?? join(tmpdir(), 'hypaper-e2e-restart-state.json');
const FIRE_TIMEOUT_S = Number(process.env.E2E_FIRE_TIMEOUT_S ?? 240);
const SOURCE = process.env.E2E_SOURCE ?? 'b';
const TESTNET_INFO = 'https://api.hyperliquid-testnet.xyz/info';

if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(BASE).hostname)) throw new Error(`REFUSING TO RUN: HYPAPER_BASE=${BASE} is not localhost`);
if (PHASE !== 'pre' && PHASE !== 'post') throw new Error('set E2E_PHASE=pre or E2E_PHASE=post');

interface State {
  pk: `0x${string}`;
  btc: { asset: number; sz: string; stopOid: number; best: number; triggerPx: string; text: string };
  sol: { asset: number; sz: string; stopOid: number; best: number; triggerPx: string; text: string };
  placedAt: number;
}
const state: State | null = PHASE === 'post' ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null;
const pk: `0x${string}` = state?.pk ?? generatePrivateKey();
const account = privateKeyToAccount(pk);
const USER = account.address.toLowerCase();

// ─── signing (same scheme as the other probes / slushy) ───────────────────────
const DOMAIN = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' } as const;
const AGENT = { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] } as const;
function connectionId(action: unknown, nonce: number): `0x${string}` {
  const packed = msgpackEncode(action);
  const buf = new Uint8Array(packed.length + 9);
  buf.set(packed, 0);
  new DataView(buf.buffer).setBigUint64(packed.length, BigInt(nonce), false);
  return keccak256(toHex(buf));
}
let lastNonce = 0;
async function exchange(action: unknown): Promise<any> {
  const nonce = Math.max(Date.now(), lastNonce + 1);
  lastNonce = nonce;
  const sig = await account.signTypedData({ domain: DOMAIN, types: AGENT, primaryType: 'Agent', message: { source: SOURCE, connectionId: connectionId(action, nonce) } });
  const signature = { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: parseInt(sig.slice(130, 132), 16) };
  const res = await fetch(`${BASE}/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, nonce, signature }) });
  return { http: res.status, ...(await res.json() as object) };
}
const post = async (url: string, body: unknown): Promise<any> => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const info = (b: unknown) => post(`${BASE}/info`, b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function testnetPost(body: unknown): Promise<any> {
  let last = '';
  for (let i = 1; i <= 6; i++) {
    const res = await fetch(TESTNET_INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    try { return JSON.parse(text); } catch { last = `HTTP ${res.status} ${text.slice(0, 80).replace(/\s+/g, ' ')}`; }
    await sleep(1500 * i);
  }
  throw new Error(`HL testnet /info kept returning non-JSON (${last})`);
}
interface Mkt { asset: number; szDecimals: number; mark: number }
async function mk(coin: string): Promise<Mkt> {
  const [meta, ctxs] = await testnetPost({ type: 'metaAndAssetCtxs' });
  const i = meta.universe.findIndex((u: any) => u.name === coin);
  if (i < 0) throw new Error(`${coin} missing on testnet`);
  return { asset: i, szDecimals: meta.universe[i].szDecimals, mark: parseFloat(ctxs[i].markPx) };
}
const fmtPx = (px: number, d: number) => parseFloat(parseFloat(px.toPrecision(5)).toFixed(Math.max(0, 6 - d))).toString();
const fmtSz = (s: number, d: number) => parseFloat(s.toFixed(d)).toString();
const sizeFor = (m: Mkt) => fmtSz(Math.ceil(12 / m.mark / 10 ** -m.szDecimals) * 10 ** -m.szDecimals, m.szDecimals);

// ─── check framework ──────────────────────────────────────────────────────────
type R = { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string };
const results: R[] = [];
const check = (name: string, ok: boolean, detail = ''): boolean => { results.push({ name, status: ok ? 'PASS' : 'FAIL', detail }); console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`); return ok; };
const skip = (name: string, detail: string) => { results.push({ name, status: 'SKIP', detail }); console.log(`  ⏭️  ${name}  — ${detail}`); };

const frontend = async (oid: number) => ((await info({ type: 'frontendOpenOrders', user: USER })) as any[]).find((o) => o.oid === oid);
const orderStatus = async (oid: number) => (await info({ type: 'orderStatus', user: USER, oid })) as any;
async function historyOf(oid: number): Promise<string[]> {
  const rows = (await info({ type: 'historicalOrders', user: USER })) as any[];
  return rows.filter((r) => r.order.oid === oid).map((r) => r.status);
}
async function historyEventually(oid: number, want: string[], ms = 8000): Promise<string[]> {
  const t0 = Date.now(); let h: string[] = [];
  while (Date.now() - t0 < ms) { h = await historyOf(oid); if (JSON.stringify(h) === JSON.stringify(want)) return h; await sleep(500); }
  return h;
}
const bestOf = (text: string | undefined): number => { const m = /best ([0-9.]+)$/.exec(text ?? ''); return m ? parseFloat(m[1]) : NaN; };
const ioc = (asset: number, isBuy: boolean, px: string, sz: string, ro: boolean) => ({ type: 'order', orders: [{ a: asset, b: isBuy, p: px, s: sz, r: ro, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' });
const stop = (asset: number, sz: string, px: string) => ({ type: 'trailingStop', asset, isBuy: false, sz, reduceOnly: true, retracement: { px }, activationPx: null });

async function positionOf(coin: string): Promise<number> {
  const s = await info({ type: 'clearinghouseState', user: USER });
  const p = (s.assetPositions ?? []).find((x: any) => x.position.coin === coin);
  return p ? parseFloat(p.position.szi) : 0;
}

// ─── PRE ──────────────────────────────────────────────────────────────────────
async function pre() {
  console.log(`\n🔬 RESTART test — phase PRE   base=${BASE}  wallet=${USER}\n`);
  const btc = await mk('BTC'); const sol = await mk('SOL');
  const meta = await info({ type: 'meta' });
  if (meta?.universe?.[btc.asset]?.name !== 'BTC') throw new Error('HyPaper is not serving the testnet universe — start it with HL_API_URL=https://api.hyperliquid-testnet.xyz');
  const btcSz = sizeFor(btc); const solSz = sizeFor(sol);

  for (const [name, m, sz] of [['BTC', btc, btcSz], ['SOL', sol, solSz]] as const) {
    const r = await exchange(ioc(m.asset, true, fmtPx(m.mark * 1.02, m.szDecimals), sz, false));
    check(`PRE: open ${name} long`, !!r.response?.data?.statuses?.[0]?.filled, JSON.stringify(r.response?.data?.statuses?.[0] ?? r));
  }
  const a = await exchange(stop(sol.asset, solSz, '2'));
  const b = await exchange(stop(btc.asset, btcSz, '5'));
  const aOid: number = a.response?.data?.oid; const bOid: number = b.response?.data?.oid;
  check('PRE: SOL stop A (px 2, to be CANCELED after the restart) placed', Number.isInteger(aOid), JSON.stringify(a.response));
  check('PRE: BTC stop B (px 5, to FIRE after the restart) placed', Number.isInteger(bOid), JSON.stringify(b.response));
  const aRow = await frontend(aOid); const bRow = await frontend(bOid);
  check('PRE: both stops resting with live triggerCondition/triggerPx', !!aRow && !!bRow && Number.isFinite(bestOf(aRow?.triggerCondition)) && Number.isFinite(bestOf(bRow?.triggerCondition)),
    `A: ${aRow?.triggerCondition} / ${aRow?.triggerPx}   B: ${bRow?.triggerCondition} / ${bRow?.triggerPx}`);
  if (results.some((x) => x.status === 'FAIL')) { report(); return; }

  const st: State = {
    pk, placedAt: Date.now(),
    sol: { asset: sol.asset, sz: solSz, stopOid: aOid, best: bestOf(aRow.triggerCondition), triggerPx: aRow.triggerPx, text: aRow.triggerCondition },
    btc: { asset: btc.asset, sz: btcSz, stopOid: bOid, best: bestOf(bRow.triggerCondition), triggerPx: bRow.triggerPx, text: bRow.triggerCondition },
  };
  writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  console.log(`\n  state saved → ${STATE_FILE}\n  NOW restart the HyPaper server, then run phase POST.`);
  report();
}

// ─── POST ─────────────────────────────────────────────────────────────────────
async function postPhase() {
  const s = state!;
  console.log(`\n🔬 RESTART test — phase POST  base=${BASE}  wallet=${USER}  (stops placed ${((Date.now() - s.placedAt) / 1000).toFixed(0)}s ago)\n`);
  const sol = await mk('SOL'); const btc = await mk('BTC');
  const alive = await info({ type: 'allMids' });
  check('POST: the restarted server answers /info', !!alive?.BTC);

  // ── state survived ──────────────────────────────────────────────────────────
  const aRow = await frontend(s.sol.stopOid);
  const aStatus = await orderStatus(s.sol.stopOid);
  check('POST: SOL stop A is still resting after the restart', !!aRow && aStatus?.order?.status === 'open', aRow?.triggerCondition);
  const aBest = bestOf(aRow?.triggerCondition);
  check('POST: A\'s watermark RESUMED (best did not go backwards: sell stops only ratchet up)', aBest >= s.sol.best, `before ${s.sol.best} → now ${aBest}`);
  check('POST: A\'s triggerPx = best − 2 (distance preserved)', Math.abs(parseFloat(aRow?.triggerPx) - (aBest - 2)) < 0.011, `best ${aBest} → ${aRow?.triggerPx}`);
  check('POST: the mark feed is alive again — A\'s best tracks the live SOL mark (±0.3 %)', Math.abs(aBest - sol.mark) / sol.mark < 0.003, `best ${aBest} vs testnet mark ${sol.mark}`);
  check('POST: the placement-time history row survived (Postgres)', (await historyOf(s.sol.stopOid)).includes('open'), JSON.stringify(await historyOf(s.sol.stopOid)));

  // ── B: still evaluating → fires ─────────────────────────────────────────────
  const bRow0 = await frontend(s.btc.stopOid);
  const bStatus0 = (await orderStatus(s.btc.stopOid))?.order?.status;
  if (bStatus0 === 'open') {
    const bBest = bestOf(bRow0?.triggerCondition);
    check('POST: BTC stop B is still resting with its persisted/resumed state', Number.isFinite(bBest) && bBest >= s.btc.best, `before ${s.btc.best} → now ${bBest} (${bRow0?.triggerCondition})`);
    check('POST: B\'s best tracks the live BTC mark (±0.3 %)', Math.abs(bBest - btc.mark) / btc.mark < 0.003, `best ${bBest} vs mark ${btc.mark}`);
  } else {
    console.log(`  (B already left the book during the restart window: status=${bStatus0} — it fired as soon as the restarted server saw a mark below its trigger)`);
  }
  const t0 = Date.now();
  let fired = bStatus0 !== 'open';
  while (!fired && (Date.now() - t0) / 1000 < FIRE_TIMEOUT_S) {
    if ((await orderStatus(s.btc.stopOid))?.order?.status !== 'open') fired = true; else await sleep(2000);
  }
  if (!fired) {
    skip('POST: B fires after the restart', `no ${5}-dollar retracement within ${FIRE_TIMEOUT_S}s (quiet market) — rerun or raise E2E_FIRE_TIMEOUT_S`);
  } else {
    const fin = await orderStatus(s.btc.stopOid);
    check('POST: B ended filled with the final "Triggered" body', fin?.order?.status === 'filled' && fin?.order?.order?.triggerCondition === 'Triggered' && fin?.order?.order?.sz === '0.0', JSON.stringify(fin?.order?.order ?? fin));
    const fills = ((await info({ type: 'userFills', user: USER })) as any[]).filter((f) => f.oid === s.btc.stopOid);
    check('POST: B\'s fill is a taker Close Long under the SAME oid', fills.length === 1 && fills[0].dir === 'Close Long' && fills[0].crossed === true, JSON.stringify(fills.map((f) => [f.dir, f.sz, f.px])));
    check('POST: the BTC position was closed by it', (await positionOf('BTC')) === 0);
    const h = await historyEventually(s.btc.stopOid, ['filled', 'triggered', 'open']);
    check('POST: historicalOrders = [filled, triggered, open] (the open row predates the restart)', JSON.stringify(h) === '["filled","triggered","open"]', JSON.stringify(h));
  }

  // ── A: can still be canceled ────────────────────────────────────────────────
  const c = await exchange({ type: 'cancel', cancels: [{ a: s.sol.asset, o: s.sol.stopOid }] });
  check('POST: A can still be canceled → ["success"]', JSON.stringify(c.response?.data?.statuses) === '["success"]', JSON.stringify(c.response));
  check('POST: A\'s orderStatus → canceled', (await orderStatus(s.sol.stopOid))?.order?.status === 'canceled');
  const hA = await historyEventually(s.sol.stopOid, ['canceled', 'open']);
  check('POST: A\'s history = [canceled, open]', JSON.stringify(hA) === '["canceled","open"]', JSON.stringify(hA));

  // ── cleanup: throwaway wallet's paper account only ──────────────────────────
  for (const [coin, m] of [['BTC', btc], ['SOL', sol]] as const) {
    const szi = await positionOf(coin);
    if (szi !== 0) await exchange(ioc(m.asset, szi < 0, fmtPx(m.mark * (szi < 0 ? 1.02 : 0.98), m.szDecimals), fmtSz(Math.abs(szi), m.szDecimals), true));
  }
  for (const o of (await info({ type: 'frontendOpenOrders', user: USER })) as any[]) {
    const m = o.coin === 'BTC' ? btc : sol;
    await exchange({ type: 'cancel', cancels: [{ a: m.asset, o: o.oid }] });
  }
  console.log(`  cleanup: BTC szi=${await positionOf('BTC')} SOL szi=${await positionOf('SOL')}`);
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  report();
}

function report() {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n══ ${pass} passed, ${fail.length} failed, ${skipped} skipped ══`);
  for (const f of fail) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(fail.length ? 1 : 0);
}

(PHASE === 'pre' ? pre() : postPhase()).catch((e) => { console.error('\n❌ restart e2e aborted:', e); process.exit(1); });
