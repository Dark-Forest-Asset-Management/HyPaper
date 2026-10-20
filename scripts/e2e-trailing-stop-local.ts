/**
 * e2e-trailing-stop-local.ts
 *
 * Real end-to-end check of HyPaper trailing stops against a LOCAL HyPaper
 * (real Redis + Postgres + the real mark-price feed), using LIVE HL TESTNET
 * mark prices. It signs every request with a throwaway key through the real
 * /exchange signature path and then walks the whole lifecycle:
 *
 *   1  place        — open a long, place a close-long trailing stop, check every info endpoint
 *   2  ratchet      — watch `best` follow the live testnet mark (monotonic, tracks the real mark)
 *   3  cancel       — normal cancel action; HL's "already canceled or filled" text on a 2nd cancel
 *   4  orphan       — close the position with a normal IOC → stop becomes reduceOnlyCanceled
 *   5  fire         — tight stop fires on a real mark move: same oid, taker fill, 3 history rows
 *   6  websocket    — orderUpdates frames: [triggered, filled] in ONE frame, orphan in the closing frame
 *   8  vault        — a stop signed with a vaultAddress lives on the VAULT's account, not the signer's
 *   9  HIP-3 sub-dex — a stop on a sub-dex coin (asset 100000+) uses the sub-dex scope + its own mark feed
 *   7  round-6 rules — pct/px validation messages, px normalisation, expiresAfter (request expiry only),
 *                      modify refusal text, PARTIAL fire when margin is short, zero-margin -> marginCanceled
 *
 * It only ever talks to HYPAPER_BASE (must be localhost) plus HL testnet READ-ONLY info calls.
 * It never places anything on HL. Cleanup (cancel leftovers, flatten) only touches the throwaway
 * wallet's paper account and runs in `finally`.
 *
 * PREREQUISITES (see the e2e section of the hand-over notes):
 *   - local Redis + Postgres, migrations applied to the LOCAL db
 *   - HyPaper running with HL_API_URL=https://api.hyperliquid-testnet.xyz and
 *     HL_WS_URL=wss://api.hyperliquid-testnet.xyz/ws  (so its universe, marks and signing
 *     source "b" are testnet's)
 *
 * RUN:   npx tsx scripts/e2e-trailing-stop-local.ts
 * ENV:   HYPAPER_BASE=http://localhost:3000   (localhost only)
 *        E2E_COIN=BTC   E2E_FIRE_PX=5   E2E_FIRE_TIMEOUT_S=300   E2E_RATCHET_WATCH_S=30
 *        E2E_SOURCE=b   (phantom-agent source; must match HyPaper's HL_API_URL: b = testnet)
 *        E2E_PRIVATE_KEY=0x…   (optional; default = a fresh throwaway key every run)
 *
 * Exit code 0 = every check passed (SKIPs allowed), 1 = a check failed.
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { keccak256, toHex } from 'viem';
import WebSocket from 'ws';

// ─── Config + guards ──────────────────────────────────────────────────────────

const BASE = process.env.HYPAPER_BASE ?? 'http://localhost:3000';
const TESTNET_INFO = 'https://api.hyperliquid-testnet.xyz/info';
const COIN = process.env.E2E_COIN ?? 'BTC';
const FIRE_PX = process.env.E2E_FIRE_PX ?? '5';
const FIRE_TIMEOUT_S = Number(process.env.E2E_FIRE_TIMEOUT_S ?? 300);
const RATCHET_WATCH_S = Number(process.env.E2E_RATCHET_WATCH_S ?? 30);
const SOURCE = process.env.E2E_SOURCE ?? 'b';

if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(BASE).hostname)) {
  throw new Error(`REFUSING TO RUN: HYPAPER_BASE=${BASE} is not localhost`);
}

const pk = (process.env.E2E_PRIVATE_KEY as `0x${string}` | undefined) ?? generatePrivateKey();
const account = privateKeyToAccount(pk);
const USER = account.address.toLowerCase();

// ─── Signing (same scheme as the probes / slushy: msgpack ‖ nonce ‖ vaultFlag 0) ──

const DOMAIN = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' } as const;
const AGENT = { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] } as const;

function connectionId(action: unknown, nonce: number, expiresAfter?: number, vault?: string): `0x${string}` {
  const packed = msgpackEncode(action);
  const vaultLen = vault ? 20 : 0;                                   // vault flag byte is always present; the address only when set
  const buf = new Uint8Array(packed.length + 9 + vaultLen + (expiresAfter !== undefined ? 9 : 0));
  buf.set(packed, 0);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(packed.length, BigInt(nonce), false);
  if (vault) {
    buf[packed.length + 8] = 1;
    buf.set(Uint8Array.from(Buffer.from(vault.slice(2), 'hex')), packed.length + 9);
  }
  if (expiresAfter !== undefined) dv.setBigUint64(packed.length + 9 + vaultLen + 1, BigInt(expiresAfter), false); // 0x00 marker + expiresAfter
  return keccak256(toHex(buf));
}

let lastNonce = 0;
async function exchange(action: unknown, opts?: { expiresAfter?: number; vault?: string }): Promise<any> {
  const nonce = Math.max(Date.now(), lastNonce + 1);
  lastNonce = nonce;
  const sig = await account.signTypedData({
    domain: DOMAIN, types: AGENT, primaryType: 'Agent',
    message: { source: SOURCE, connectionId: connectionId(action, nonce, opts?.expiresAfter, opts?.vault) },
  });
  const signature = { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: parseInt(sig.slice(130, 132), 16) };
  const res = await fetch(`${BASE}/exchange`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature, ...(opts?.expiresAfter !== undefined ? { expiresAfter: opts.expiresAfter } : {}), ...(opts?.vault ? { vaultAddress: opts.vault } : {}) }),
  });
  return { http: res.status, ...(await res.json() as object) };
}

async function post(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
const info = (body: unknown) => post(`${BASE}/info`, body);
const bestOf9 = (text: string | undefined): number => { const m = /best ([0-9.]+)$/.exec(text ?? ''); return m ? parseFloat(m[1]) : NaN; };
const hypaper = (type: string, extra: object = {}) => post(`${BASE}/hypaper`, { type, user: USER, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Tiny check framework ─────────────────────────────────────────────────────

type Result = { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string };
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): boolean {
  results.push({ name, status: ok ? 'PASS' : 'FAIL', detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}
function skip(name: string, detail: string) {
  results.push({ name, status: 'SKIP', detail });
  console.log(`  ⏭️  ${name}  — ${detail}`);
}

// ─── Market helpers (live TESTNET marks, read-only) ───────────────────────────

interface Mkt { asset: number; szDecimals: number; mark: number }
/** Read-only testnet info call with retries: the public endpoint occasionally answers with an HTML error/rate-limit page. */
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
async function testnetMarket(): Promise<Mkt> {
  const [meta, ctxs] = await testnetPost({ type: 'metaAndAssetCtxs' }) as [{ universe: Array<{ name: string; szDecimals: number }> }, Array<{ markPx: string }>];
  const asset = meta.universe.findIndex((u) => u.name === COIN);
  if (asset < 0) throw new Error(`${COIN} not in testnet universe`);
  return { asset, szDecimals: meta.universe[asset].szDecimals, mark: parseFloat(ctxs[asset].markPx) };
}
/** HL perp price rule: ≤5 significant figures and ≤ 6−szDecimals decimals. */
function fmtPx(px: number, szDecimals: number): string {
  return parseFloat(parseFloat(px.toPrecision(5)).toFixed(Math.max(0, 6 - szDecimals))).toString();
}
const fmtSz = (s: number, d: number) => parseFloat(s.toFixed(d)).toString();

// ─── HyPaper helpers ──────────────────────────────────────────────────────────

const ioc = (asset: number, isBuy: boolean, px: string, sz: string, reduceOnly: boolean) => ({
  type: 'order', orders: [{ a: asset, b: isBuy, p: px, s: sz, r: reduceOnly, t: { limit: { tif: 'Ioc' } } }], grouping: 'na',
});
const stopAction = (asset: number, sz: string, px: string, isBuy = false, reduceOnly = true) => ({
  type: 'trailingStop', asset, isBuy, sz, reduceOnly, retracement: { px }, activationPx: null,
});
const frontend = async (oid: number) => ((await info({ type: 'frontendOpenOrders', user: USER })) as any[]).find((o) => o.oid === oid);
const orderStatus = async (oid: number) => (await info({ type: 'orderStatus', user: USER, oid })) as any;
const position = async (): Promise<number> => {
  const s = await info({ type: 'clearinghouseState', user: USER });
  const p = (s.assetPositions ?? []).find((x: any) => x.position.coin === COIN);
  return p ? parseFloat(p.position.szi) : 0;
};
async function history(oid: number): Promise<string[]> {
  const rows = await info({ type: 'historicalOrders', user: USER }) as any[];
  return rows.filter((r) => r.order.oid === oid).map((r) => r.status);
}
/** pg-sink writes asynchronously — poll briefly. */
async function historyEventually(oid: number, want: string[], timeoutMs = 8000): Promise<string[]> {
  const t0 = Date.now();
  let h: string[] = [];
  while (Date.now() - t0 < timeoutMs) {
    h = await history(oid);
    if (JSON.stringify(h) === JSON.stringify(want)) return h;
    await sleep(500);
  }
  return h;
}

// ─── WebSocket recorder (HyPaper /ws, orderUpdates for our wallet) ────────────

const frames: Array<{ t: number; data: any[] }> = [];
function startWs(): { close: () => void; ready: Promise<void> } {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
  const ready = new Promise<void>((res, rej) => {
    ws.on('open', () => { ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'orderUpdates', user: USER } })); res(); });
    ws.on('error', rej);
  });
  ws.on('message', (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.channel === 'orderUpdates' && Array.isArray(m.data)) frames.push({ t: Date.now(), data: m.data });
    } catch { /* ignore */ }
  });
  return { ready, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}
const framesFor = (oid: number) => frames.filter((f) => f.data.some((d) => d.order.oid === oid));

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔬 HyPaper trailing-stop e2e   base=${BASE}  coin=${COIN}  wallet=${USER}`);
  console.log('   (throwaway wallet — HyPaper creates its paper account + faucet balance on first request)\n');

  const mkt = await testnetMarket();
  const { asset, szDecimals } = mkt;
  const minSz = 1 / 10 ** szDecimals;
  const sz = fmtSz(Math.ceil(12 / mkt.mark / minSz) * minSz, szDecimals);

  // Sanity: HyPaper must be serving the SAME (testnet) universe, otherwise asset ids/marks differ.
  const meta = await info({ type: 'meta' });
  if (meta?.universe?.[asset]?.name !== COIN) {
    throw new Error(`HyPaper's universe[${asset}] is "${meta?.universe?.[asset]?.name}", testnet's is ${COIN} — start HyPaper with HL_API_URL=https://api.hyperliquid-testnet.xyz`);
  }
  console.log(`  testnet ${COIN}: asset=${asset} mark=${mkt.mark}  size=${sz}`);

  const ws = startWs();
  await ws.ready;

  const openLong = async (label: string) => {
    const m = await testnetMarket();
    const r = await exchange(ioc(asset, true, fmtPx(m.mark * 1.02, szDecimals), sz, false));
    return check(`${label}: open long (IOC buy)`, r.status === 'ok' && !!r.response?.data?.statuses?.[0]?.filled, JSON.stringify(r.response?.data?.statuses?.[0] ?? r));
  };
  const closeLong = async (label: string) => {
    const m = await testnetMarket();
    const r = await exchange(ioc(asset, false, fmtPx(m.mark * 0.98, szDecimals), sz, true));
    return check(`${label}: close long (IOC sell, reduce-only)`, r.status === 'ok' && !!r.response?.data?.statuses?.[0]?.filled);
  };

  try {
    // ── 1. PLACE ──────────────────────────────────────────────────────────────
    console.log('\n[1] place');
    if (!(await openLong('1'))) throw new Error('cannot continue without a position');
    const placed = await exchange(stopAction(asset, sz, '3000'));
    check('1: trailingStop accepted → {type:"trailingStop", data:{oid}}',
      placed.status === 'ok' && placed.response?.type === 'trailingStop' && Number.isInteger(placed.response?.data?.oid), JSON.stringify(placed));
    const oid1: number = placed.response.data.oid;

    const row = await frontend(oid1);
    check('1: frontendOpenOrders row: orderType "Trailing Stop Market", isTrigger, tif null',
      row?.orderType === 'Trailing Stop Market' && row?.isTrigger === true && row?.tif === null && row?.cloid === null, JSON.stringify(row));
    const m1 = /^Activation immediate, retracement 3000, best ([0-9.]+)$/.exec(row?.triggerCondition ?? '');
    check('1: triggerCondition prose matches HL\'s grammar', !!m1, row?.triggerCondition);
    const best0 = m1 ? parseFloat(m1[1]) : NaN;
    check('1: triggerPx = best − 3000 (sell)', Math.abs(parseFloat(row?.triggerPx) - (best0 - 3000)) < 0.11, `best ${best0} → ${row?.triggerPx}`);
    check('1: best is seeded from the live testnet MARK (within 0.1 %)', Math.abs(best0 - mkt.mark) / mkt.mark < 0.001, `best ${best0} vs testnet mark ${mkt.mark}`);
    const open = ((await info({ type: 'openOrders', user: USER })) as any[]).find((o) => o.oid === oid1);
    check('1: openOrders row is plain (no triggerCondition/orderType), reduceOnly true',
      !!open && !('triggerCondition' in open) && !('orderType' in open) && open.reduceOnly === true, JSON.stringify(open));
    const st0 = await orderStatus(oid1);
    check('1: orderStatus open', st0?.order?.status === 'open');

    // ── 2. RATCHET ────────────────────────────────────────────────────────────
    console.log(`\n[2] ratchet — watching ${RATCHET_WATCH_S}s of live testnet marks`);
    const bests: number[] = [best0];
    const t0 = Date.now();
    while ((Date.now() - t0) / 1000 < RATCHET_WATCH_S) {
      await sleep(3000);
      const r = await frontend(oid1);
      const mm = /best ([0-9.]+)$/.exec(r?.triggerCondition ?? '');
      if (mm) bests.push(parseFloat(mm[1]));
    }
    const monotonic = bests.every((b, i) => i === 0 || b >= bests[i - 1]);
    check('2: best never decreases (sell stop ratchets UP only)', monotonic, `observed: ${[...new Set(bests)].join(' → ')}`);
    const finalMark = (await testnetMarket()).mark;
    check('2: best tracks the live testnet mark', Math.abs(bests[bests.length - 1] - finalMark) / finalMark < 0.002, `best ${bests[bests.length - 1]} vs mark ${finalMark}`);
    if (new Set(bests).size > 1) {
      const frozen = await orderStatus(oid1);
      check('2: orderStatus stays a frozen snapshot while frontendOpenOrders moved (HL parity)',
        frozen?.order?.order?.triggerCondition?.endsWith(`best ${best0}`), frozen?.order?.order?.triggerCondition);
    } else {
      skip('2: orderStatus frozen-vs-live', 'mark did not move during the watch window (quiet market) — raise E2E_RATCHET_WATCH_S');
    }

    // ── 3. CANCEL ─────────────────────────────────────────────────────────────
    console.log('\n[3] cancel');
    const c1 = await exchange({ type: 'cancel', cancels: [{ a: asset, o: oid1 }] });
    check('3: cancel → ["success"]', JSON.stringify(c1.response?.data?.statuses) === '["success"]', JSON.stringify(c1));
    check('3: orderStatus → canceled (US spelling)', (await orderStatus(oid1))?.order?.status === 'canceled');
    const c2 = await exchange({ type: 'cancel', cancels: [{ a: asset, o: oid1 }] });
    check('3: second cancel → HL\'s exact "already canceled or filled" text',
      c2.response?.data?.statuses?.[0]?.error === `Order was never placed, already canceled, or filled. asset=${asset}`, JSON.stringify(c2.response?.data));
    const h1 = await historyEventually(oid1, ['canceled', 'open']);
    check('3: historicalOrders = [canceled, open]', JSON.stringify(h1) === '["canceled","open"]', JSON.stringify(h1));

    // ── 4. ORPHAN ─────────────────────────────────────────────────────────────
    console.log('\n[4] orphan (position closed under a reduce-only stop)');
    const placed2 = await exchange(stopAction(asset, sz, '3000'));
    const oid2: number = placed2.response?.data?.oid;
    check('4: second stop placed', Number.isInteger(oid2));
    await closeLong('4');
    let st2: any;
    for (let i = 0; i < 10; i++) { st2 = await orderStatus(oid2); if (st2?.order?.status !== 'open') break; await sleep(500); }
    check('4: stop auto-canceled with status reduceOnlyCanceled', st2?.order?.status === 'reduceOnlyCanceled', st2?.order?.status);
    check('4: gone from frontendOpenOrders; position flat', !(await frontend(oid2)) && (await position()) === 0);
    const h2 = await historyEventually(oid2, ['reduceOnlyCanceled', 'open']);
    check('4: historicalOrders = [reduceOnlyCanceled, open]', JSON.stringify(h2) === '["reduceOnlyCanceled","open"]', JSON.stringify(h2));
    const orphanFrame = frames.find((f) => f.data.some((d) => d.order.oid === oid2 && d.status === 'reduceOnlyCanceled'));
    check('4: ws — the orphan cancel rides in the SAME frame as the closing order\'s "filled"',
      !!orphanFrame && orphanFrame.data.some((d) => d.status === 'filled' && d.order.oid !== oid2), JSON.stringify(orphanFrame?.data.map((d) => [d.order.oid, d.status])));

    // ── 5. FIRE ───────────────────────────────────────────────────────────────
    console.log(`\n[5] fire — tight retracement px ${FIRE_PX}, waiting up to ${FIRE_TIMEOUT_S}s for a real testnet mark move`);
    await openLong('5');
    const placed3 = await exchange(stopAction(asset, sz, FIRE_PX));
    const oid3: number = placed3.response?.data?.oid;
    check('5: tight stop placed', Number.isInteger(oid3), JSON.stringify(placed3));
    const t1 = Date.now();
    let fired = false;
    let lastCond = '';
    while ((Date.now() - t1) / 1000 < FIRE_TIMEOUT_S) {
      const live = await frontend(oid3);
      if (live) lastCond = live.triggerCondition;
      const s = await orderStatus(oid3);
      if (s?.order?.status === 'filled') { fired = true; break; }
      await sleep(2000);
    }
    if (!fired) {
      skip('5: fire', `no mark retracement of ${FIRE_PX} within ${FIRE_TIMEOUT_S}s (last: "${lastCond}") — quiet market; rerun or raise E2E_FIRE_TIMEOUT_S`);
    } else {
      console.log(`  🔥 fired after ${((Date.now() - t1) / 1000).toFixed(0)}s (last live text: "${lastCond}")`);
      const fin = await orderStatus(oid3);
      check('5: orderStatus filled, final body Triggered / isTrigger false / sz 0.0 / tif Gtc',
        fin.order.order.triggerCondition === 'Triggered' && fin.order.order.isTrigger === false && fin.order.order.sz === '0.0' && fin.order.order.tif === 'Gtc', JSON.stringify(fin.order.order));
      const fills = await info({ type: 'userFills', user: USER }) as any[];
      const f = fills.find((x) => x.oid === oid3);
      check('5: fill reuses the SAME oid: Close Long, crossed (taker), fee > 0',
        !!f && f.dir === 'Close Long' && f.crossed === true && parseFloat(f.fee) > 0, JSON.stringify(f));
      check('5: position closed by the fill', (await position()) === 0);
      const h3 = await historyEventually(oid3, ['filled', 'triggered', 'open']);
      check('5: historicalOrders = [filled, triggered, open]', JSON.stringify(h3) === '["filled","triggered","open"]', JSON.stringify(h3));
      const fireFrame = frames.find((fr) => fr.data.some((d) => d.order.oid === oid3 && d.status === 'triggered'));
      check('5: ws — ONE frame carrying [triggered, filled]',
        JSON.stringify(fireFrame?.data.filter((d) => d.order.oid === oid3).map((d) => d.status)) === '["triggered","filled"]', JSON.stringify(fireFrame?.data.map((d) => [d.order.oid, d.status])));
      const filledEntry = fireFrame?.data.find((d) => d.status === 'filled');
      check('5: ws filled entry has sz "0.0" and a plain body (no triggerCondition)', filledEntry?.order?.sz === '0.0' && !('triggerCondition' in (filledEntry?.order ?? {})));
    }

    // ── 6. WS summary ─────────────────────────────────────────────────────────
    console.log('\n[6] websocket');
    const stopStatuses = new Set(frames.flatMap((f) => f.data).filter((d) => [oid1, oid2, oid3].includes(d.order.oid)).map((d) => d.status));
    check('6: only open / canceled / reduceOnlyCanceled / triggered / filled are ever sent for stops (no activation/ratchet events)',
      [...stopStatuses].every((s) => ['open', 'canceled', 'reduceOnlyCanceled', 'triggered', 'filled'].includes(s)), [...stopStatuses].join(','));
    check('6: user cancel arrived as "canceled" (US spelling)', framesFor(oid1).some((f) => f.data.some((d) => d.status === 'canceled')));

    // ── 7. ROUND-6 RULES ──────────────────────────────────────────────────────
    console.log('\n[7] round-6 rules (flat, signed requests against the real route)');
    const rawStop = (retracement: object, extra: object = {}) => ({
      type: 'trailingStop', asset, isBuy: false, sz, reduceOnly: true, retracement, activationPx: null, ...extra,
    });
    const errText = (r: any) => (r.status === 'err' && r.http === 200 ? r.response : `<http ${r.http} ${r.status}: ${JSON.stringify(r.response)}>`);

    // 7a validation messages (HTTP 200 + status "err", HL's exact strings)
    const cases: Array<[string, object, string]> = [
      ['pct without %', { pct: '5.0000' }, 'Percentage is invalid.'],
      ['pct 0.0001% (not a multiple of 0.001%)', { pct: '0.0001%' }, 'Percentage is invalid.'],
      ['pct 99.9999%', { pct: '99.9999%' }, 'Percentage is invalid.'],
      ['pct 100%', { pct: '100.0000%' }, 'Trailing stop retracement is invalid.'],
      ['pct 0%', { pct: '0.0000%' }, 'Trailing stop retracement is invalid.'],
      ['px 0.05 (rounds to 0 at BTC\'s 1 price decimal)', { px: '0.05' }, 'Error converting float to price'],
      ['px 1000000 (>= price)', { px: '1000000' }, 'Trailing stop retracement is invalid.'],
    ];
    for (const [name, ret, want] of cases) {
      const r = await exchange(rawStop(ret));
      check(`7a: ${name} → "${want}"`, errText(r) === want, errText(r));
    }
    for (const spelling of ['5%', '5.0%', '05.0000%', '0.0010%']) {
      const r = await exchange(rawStop({ pct: spelling }));
      const o = r.response?.data?.oid;
      check(`7a: pct spelling "${spelling}" accepted`, r.status === 'ok' && Number.isInteger(o));
      if (o) await exchange({ type: 'cancel', cancels: [{ a: asset, o }] });
    }

    // 7b px normalisation: BTC has 1 price decimal, so 0.15 → 0.1 and that is what the text echoes
    const norm = await exchange(rawStop({ px: '0.15' }));
    const normOid: number | undefined = norm.response?.data?.oid;
    const normRow = normOid ? await frontend(normOid) : null;
    check('7b: px 0.15 is normalised to 0.1 and the echoed text uses 0.1', /retracement 0\.1, best /.test(normRow?.triggerCondition ?? ''), normRow?.triggerCondition);
    if (normOid) await exchange({ type: 'cancel', cancels: [{ a: asset, o: normOid }] });

    // 7c expiresAfter = REQUEST expiry
    const past = await exchange(rawStop({ px: '3000' }), { expiresAfter: Date.now() - 5000 });
    check('7c: expiresAfter in the past → HTTP 200 "Action already expired"', errText(past) === 'Action already expired', errText(past));
    const fut = await exchange(rawStop({ px: '3000' }), { expiresAfter: Date.now() + 6000 });
    const futOid: number | undefined = fut.response?.data?.oid;
    check('7c: a future expiresAfter is accepted (the signature covers it)', fut.status === 'ok' && !!futOid, JSON.stringify(fut.response));
    if (futOid) {
      await sleep(12_000);   // well past the deadline: the ORDER must not expire
      check('7c: the stop is STILL open after its expiresAfter passed (request expiry, not order expiry)', (await orderStatus(futOid))?.order?.status === 'open' && !!(await frontend(futOid)));
      await exchange({ type: 'cancel', cancels: [{ a: asset, o: futOid }] });
    }

    // 7d modify / batchModify on a trailing stop
    const mod = await exchange(rawStop({ px: '3000' }));
    const modOid: number | undefined = mod.response?.data?.oid;
    if (modOid) {
      const wire = { a: asset, b: true, p: fmtPx(mkt.mark * 0.9, szDecimals), s: sz, r: false, t: { limit: { tif: 'Gtc' } } };
      const m1 = await exchange({ type: 'modify', oid: modOid, order: wire });
      check('7d: modify → HTTP 200 "Attempted to modify to invalid new order"', errText(m1) === 'Attempted to modify to invalid new order', errText(m1));
      const m2 = await exchange({ type: 'batchModify', modifies: [{ oid: modOid, order: wire }] });
      check('7d: batchModify → ok with statuses[0].error = the same text', m2.status === 'ok' && m2.response?.data?.statuses?.[0]?.error === 'Attempted to modify to invalid new order', JSON.stringify(m2.response));
      check('7d: the stop is untouched (still a resting Trailing Stop Market)', (await frontend(modOid))?.orderType === 'Trailing Stop Market');
      await exchange({ type: 'cancel', cancels: [{ a: asset, o: modOid }] });
    } else {
      skip('7d: modify', 'could not place the target stop');
    }

    // 7e/7f partial fire when the margin is short, then a zero-margin fire.
    // A tiny paper balance (HyPaper's own /hypaper setBalance) makes a ~$400 stop unaffordable at the default 20x.
    console.log('\n[7e] margin short at fire time (paper balance set to $3)');
    await hypaper('setBalance', { balance: 3 });
    const bigSz = fmtSz(Math.ceil(400 / mkt.mark / 1e-5) * 1e-5, szDecimals);
    const big = await exchange(stopAction(asset, bigSz, FIRE_PX, true, false));
    const bigOid: number | undefined = big.response?.data?.oid;
    check('7e: a buy stop far beyond the margin is ACCEPTED at placement (margin is only checked at fire)', big.status === 'ok' && !!bigOid, JSON.stringify(big.response));
    if (bigOid) {
      const tFire = Date.now();
      let fired7 = false;
      while ((Date.now() - tFire) / 1000 < FIRE_TIMEOUT_S) {
        if ((await orderStatus(bigOid))?.order?.status !== 'open') { fired7 = true; break; }
        await sleep(2000);
      }
      if (!fired7) {
        skip('7e: partial fire', `the mark did not rise ${FIRE_PX} off its low within ${FIRE_TIMEOUT_S}s (quiet market)`);
      } else {
        const st = await orderStatus(bigOid);
        const fills = (await info({ type: 'userFills', user: USER }) as any[]).filter((x) => x.oid === bigOid);
        const filledSz = fills.reduce((a, x) => a + parseFloat(x.sz), 0);
        const full = parseFloat(bigSz);
        const expected = (3 * 20) / mkt.mark;
        check('7e: ends "filled" (NOT marginCanceled) and filled only part of the size', st?.order?.status === 'filled' && filledSz > 0 && filledSz < full, `status=${st?.order?.status} filled ${filledSz} of ${full}`);
        check('7e: the filled size is what $3 of margin at 20x buys (±15 %)', Math.abs(filledSz - expected) / expected < 0.15, `filled ${filledSz} vs ≈${expected.toFixed(6)}`);
        check('7e: the final body keeps the UNFILLED REMAINDER in sz', Math.abs(parseFloat(st?.order?.order?.sz) - (full - filledSz)) < 2e-5, `body.sz=${st?.order?.order?.sz}`);
        check('7e: historicalOrders = [filled, triggered, open]', JSON.stringify(await historyEventually(bigOid, ['filled', 'triggered', 'open'])) === '["filled","triggered","open"]');
        const fr = frames.find((f) => f.data.some((d) => d.order.oid === bigOid && d.status === 'triggered'));
        const fe = fr?.data.filter((d) => d.order.oid === bigOid);
        check('7e: ws — ONE frame [triggered(full sz), filled(sz = remainder)]',
          !!fe && fe.map((d) => d.status).join() === 'triggered,filled' && Math.abs(parseFloat(fe[0].order.sz) - full) < 1e-9 && Math.abs(parseFloat(fe[1].order.sz) - (full - filledSz)) < 2e-5, JSON.stringify(fe?.map((d) => [d.status, d.order.sz])));

        // 7f: that position now uses all the margin → a second stop has NOTHING affordable
        console.log('\n[7f] zero free margin');
        const zero = await exchange(stopAction(asset, bigSz, FIRE_PX, true, false));
        const zeroOid: number | undefined = zero.response?.data?.oid;
        check('7f: second big stop accepted', zero.status === 'ok' && !!zeroOid);
        if (zeroOid) {
          const tz = Date.now();
          let fired7f = false;
          while ((Date.now() - tz) / 1000 < FIRE_TIMEOUT_S) {
            if ((await orderStatus(zeroOid))?.order?.status !== 'open') { fired7f = true; break; }
            await sleep(2000);
          }
          if (!fired7f) {
            skip('7f: zero-margin fire', `no ${FIRE_PX} rebound within ${FIRE_TIMEOUT_S}s (quiet market)`);
          } else {
            const st2 = await orderStatus(zeroOid);
            const f2 = (await info({ type: 'userFills', user: USER }) as any[]).filter((x) => x.oid === zeroOid);
            check('7f: status marginCanceled, no fill', st2?.order?.status === 'marginCanceled' && f2.length === 0, `status=${st2?.order?.status} fills=${f2.length}`);
            check('7f: historicalOrders = [marginCanceled, triggered, open]', JSON.stringify(await historyEventually(zeroOid, ['marginCanceled', 'triggered', 'open'])) === '["marginCanceled","triggered","open"]');
            const fr2 = frames.find((f) => f.data.some((d) => d.order.oid === zeroOid && d.status === 'triggered'));
            check('7f: ws — ONE frame [triggered, marginCanceled]', fr2?.data.filter((d) => d.order.oid === zeroOid).map((d) => d.status).join() === 'triggered,marginCanceled', JSON.stringify(fr2?.data.map((d) => [d.order.oid, d.status])));
          }
        }
      }
    }

    // ── 8. VAULT / sub-account ──────────────────────────────────────────────────
    console.log('\n[8] vault (sub-account) stop');
    {
      const VAULT = ('0x' + [...Array(40)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')) as string;
      const v = await exchange(stopAction(asset, sz, '3000'), { vault: VAULT });
      const vOid: number | undefined = v.response?.data?.oid;
      check('8: a stop signed with a vaultAddress is accepted (the signature covers the vault)', v.status === 'ok' && !!vOid, JSON.stringify(v.response));
      if (vOid) {
        const onVault = ((await info({ type: 'frontendOpenOrders', user: VAULT })) as any[]).some((o) => o.oid === vOid);
        const onSigner = ((await info({ type: 'frontendOpenOrders', user: USER })) as any[]).some((o) => o.oid === vOid);
        check('8: it rests on the VAULT\'s account and NOT on the signer\'s', onVault && !onSigner, `vault=${onVault} signer=${onSigner}`);
        const c = await exchange({ type: 'cancel', cancels: [{ a: asset, o: vOid }] }, { vault: VAULT });
        check('8: canceling through the vault works', JSON.stringify(c.response?.data?.statuses) === '["success"]', JSON.stringify(c.response));
      }
    }

    // ── 9. HIP-3 sub-dex coin ───────────────────────────────────────────────────
    console.log('\n[9] HIP-3 sub-dex coin');
    {
      const dexes = (await info({ type: 'perpDexs' })) as Array<{ name: string } | null>;
      let picked: { dex: string; coin: string; asset: number; szDecimals: number; mark: number } | null = null;
      for (let di = 1; di < dexes.length && !picked; di++) {
        const d = dexes[di];
        if (!d?.name) continue;
        const r = await testnetPost({ type: 'metaAndAssetCtxs', dex: d.name }).catch(() => null);
        if (!r) continue;
        const [meta2, ctxs2] = r as [{ universe: Array<{ name: string; szDecimals: number; isDelisted?: boolean }> }, Array<{ markPx?: string }>];
        for (let ui = 0; ui < meta2.universe.length; ui++) {
          const mark2 = parseFloat(ctxs2[ui]?.markPx ?? '0');
          if (mark2 > 0 && !meta2.universe[ui].isDelisted) { picked = { dex: d.name, coin: meta2.universe[ui].name, asset: 100_000 + di * 10_000 + ui, szDecimals: meta2.universe[ui].szDecimals, mark: mark2 }; break; }
        }
      }
      if (!picked) {
        skip('9: HIP-3 stop', 'no sub-dex coin with a live mark found on testnet');
      } else {
        console.log(`  using ${picked.coin} (asset ${picked.asset}, szDecimals ${picked.szDecimals}, mark ${picked.mark})`);
        const sz9 = fmtSz(Math.ceil(12 / picked.mark / 10 ** -picked.szDecimals) * 10 ** -picked.szDecimals, picked.szDecimals);
        const px9 = fmtPx(picked.mark * 0.01, picked.szDecimals);
        const r9 = await exchange({ type: 'trailingStop', asset: picked.asset, isBuy: false, sz: sz9, reduceOnly: true, retracement: { px: px9 }, activationPx: null });
        const o9: number | undefined = r9.response?.data?.oid;
        check('9: a sub-dex stop is accepted', r9.status === 'ok' && !!o9, JSON.stringify(r9.response));
        if (o9) {
          const inDex = ((await info({ type: 'frontendOpenOrders', user: USER, dex: picked.dex })) as any[]).find((o) => o.oid === o9);
          const inNative = ((await info({ type: 'frontendOpenOrders', user: USER })) as any[]).some((o) => o.oid === o9);
          check('9: it appears under the sub-dex scope (coin "dex:SYM") and NOT in the native list', !!inDex && inDex.coin === picked.coin && !inNative, `coin=${inDex?.coin} native=${inNative}`);
          const b0 = bestOf9(inDex?.triggerCondition);
          check('9: best is seeded from the sub-dex mark (±1 %)', Math.abs(b0 - picked.mark) / picked.mark < 0.01, `best ${b0} vs testnet ${picked.mark}`);
          // the mark feed for a dex coin: let the per-coin WS sub / the 5 s HTTP fallback run, then compare with the live mark
          await sleep(15_000);
          const live = await testnetPost({ type: 'metaAndAssetCtxs', dex: picked.dex }) as [{ universe: Array<{ name: string }> }, Array<{ markPx: string }>];
          const liveMark = parseFloat(live[1][live[0].universe.findIndex((u) => u.name === picked!.coin)].markPx);
          const row2 = ((await info({ type: 'frontendOpenOrders', user: USER, dex: picked.dex })) as any[]).find((o) => o.oid === o9);
          const b1 = bestOf9(row2?.triggerCondition);
          check('9: best still tracks the live sub-dex mark after 15 s (mark feed works for HIP-3 coins)', Math.abs(b1 - liveMark) / liveMark < 0.01, `best ${b1} vs live mark ${liveMark}`);
          const c9 = await exchange({ type: 'cancel', cancels: [{ a: picked.asset, o: o9 }] });
          check('9: it can be canceled', JSON.stringify(c9.response?.data?.statuses) === '["success"]', JSON.stringify(c9.response));
        }
      }
    }
  } finally {
    // Cleanup — throwaway wallet's paper account only.
    console.log('\n🧹 cleanup');
    try {
      const resting = (await info({ type: 'frontendOpenOrders', user: USER }) as any[]).filter((o) => o.coin === COIN);
      for (const o of resting) await exchange({ type: 'cancel', cancels: [{ a: asset, o: o.oid }] });
      const szi = await position();
      if (szi !== 0) {
        const m = await testnetMarket();
        const isBuy = szi < 0;
        await exchange(ioc(asset, isBuy, fmtPx(m.mark * (isBuy ? 1.02 : 0.98), szDecimals), fmtSz(Math.abs(szi), szDecimals), true));
      }
      console.log(`  cancelled ${resting.length} leftover order(s); final szi = ${await position()}`);
    } catch (e) { console.error('  cleanup failed:', e); }
    ws.close();
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n══ ${pass} passed, ${fail.length} failed, ${skipped} skipped ══`);
  for (const f of fail) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((err) => { console.error('\n❌ e2e aborted:', err); process.exit(1); });
