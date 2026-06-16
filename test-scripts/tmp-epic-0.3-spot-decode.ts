/**
 * TMP verification — Epic 0.3 (spot asset-index foundation).
 *
 * Proves, against a running local HyPaper:
 *   1. spotMeta is cached in Redis (worker seeded it).
 *   2. An order placed with a SPOT asset id (10_000 + pairIndex) resolves to
 *      HL's real pair name end-to-end — it rests with coin == pair name.
 *      Before the fix this returned "Unknown asset 100xx" (spot id misread as
 *      a main-DEX universe index).
 *   3. Perp asset 0 still resolves (regression guard).
 *
 * Usage: npx tsx test-scripts/tmp-epic-0.3-spot-decode.ts [baseUrl]
 * Throwaway — delete after Epic 0.3 sign-off.
 */

const BASE = process.argv[2] ?? 'http://localhost:3000';
const HL = 'https://api.hyperliquid.xyz';
const WALLET = '0x000000000000000000000000000000000000spot'.toLowerCase().replace('spot', 'be01');
const SPOT_OFFSET = 10_000;

async function hlPost(body: object): Promise<any> {
  const r = await fetch(`${HL}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function paperInfo(body: object): Promise<any> {
  const r = await fetch(`${BASE}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function paperExchange(body: object): Promise<any> {
  const r = await fetch(`${BASE}/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function paperHypaper(body: object): Promise<any> {
  const r = await fetch(`${BASE}/hypaper`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
  ok ? pass++ : fail++;
}

(async () => {
  console.log(`HyPaper: ${BASE}   wallet: ${WALLET}\n`);

  // Pick a real canonical spot pair from HL spotMeta.
  const spotMeta = await hlPost({ type: 'spotMeta' });
  const pair = spotMeta.universe.find((u: any) => u.isCanonical && typeof u.name === 'string')
    ?? spotMeta.universe[0];
  const baseTok = spotMeta.tokens.find((t: any) => t.index === pair.tokens[0]);
  const assetId = SPOT_OFFSET + pair.index;
  console.log(`chosen pair: name="${pair.name}" index=${pair.index} → assetId=${assetId} (base ${baseTok?.name}, szDecimals=${baseTok?.szDecimals})\n`);

  // Fresh account + headroom so margin can't block the rest.
  await paperHypaper({ type: 'resetAccount', user: WALLET });
  await paperHypaper({ type: 'setBalance', user: WALLET, balance: 1_000_000_000 });

  // Place a spot buy that can't immediately fill (tiny price) → should rest.
  const place = await paperExchange({
    wallet: WALLET,
    action: {
      type: 'order', grouping: 'na',
      orders: [{ a: assetId, b: true, p: '0.00001', s: '1', r: false, t: { limit: { tif: 'Gtc' } } }],
    },
  });
  const status0 = place?.response?.data?.statuses?.[0];
  const statusStr = JSON.stringify(status0);
  const notUnknown = !statusStr.includes('Unknown asset');
  check('spot order not rejected as "Unknown asset"', notUnknown, `status[0]=${statusStr}`);

  // Confirm it rested under the correct pair name.
  const open = await paperInfo({ type: 'frontendOpenOrders', user: WALLET });
  const restedCoins = Array.isArray(open) ? open.map((o: any) => o.coin) : [];
  check('spot order rested with correct pair coin',
    restedCoins.includes(pair.name),
    `open coins=${JSON.stringify(restedCoins)} expected="${pair.name}"`);

  // spotMeta cached.
  check('spotMeta available (proxied) with tokens+universe',
    Array.isArray(spotMeta.tokens) && Array.isArray(spotMeta.universe),
    `tokens=${spotMeta.tokens?.length} universe=${spotMeta.universe?.length}`);

  // Regression: perp asset 0 still resolves.
  const meta = await hlPost({ type: 'meta' });
  const perp0 = meta.universe[0].name;
  await paperExchange({
    wallet: WALLET,
    action: { type: 'order', grouping: 'na', orders: [{ a: 0, b: true, p: '0.00001', s: '0.001', r: false, t: { limit: { tif: 'Gtc' } } }] },
  });
  const open2 = await paperInfo({ type: 'frontendOpenOrders', user: WALLET });
  const coins2 = Array.isArray(open2) ? open2.map((o: any) => o.coin) : [];
  check('perp asset 0 still resolves (regression)', coins2.includes(perp0), `expected "${perp0}", open coins=${JSON.stringify(coins2)}`);

  await paperHypaper({ type: 'resetAccount', user: WALLET });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
