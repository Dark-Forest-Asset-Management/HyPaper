/**
 * TMP verification — Epic 0.1 (info routing user-gate backstop).
 *
 * Proves, against a running local HyPaper (default http://localhost:3000):
 *   1. User-scoped types with no paper handler are NOT proxied to live HL —
 *      they return a typed empty ([] or {}).  → no real on-chain data leaks
 *      into the paper sim.
 *   2. The definitive case: `portfolio`. Live HL returns a NON-empty period
 *      skeleton (day/week/month/allTime...) even for an empty/unknown wallet,
 *      so HyPaper returning [] can ONLY mean it refused to proxy.
 *   3. Market/reference unknown types (no `user`) STILL proxy (forward-compat).
 *   4. PROXY_ANYWAY user types (spotClearinghouseState) still passthrough.
 *   5. Existing local handlers (clearinghouseState) still serve paper state.
 *
 * Usage: npx tsx test-scripts/tmp-epic-0.1-info-gate.ts [baseUrl] [wallet]
 * Throwaway — delete after Epic 0.1 sign-off.
 */

const BASE = process.argv[2] ?? 'http://localhost:3000';
const WALLET = process.argv[3] ?? '0x000000000000000000000000000000000000beef';
const HL = 'https://api.hyperliquid.xyz';

async function post(base: string, body: object): Promise<unknown> {
  const r = await fetch(`${base}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { __nonjson: text, __status: r.status }; }
}

const isEmptyArray = (v: unknown) => Array.isArray(v) && v.length === 0;
const isEmptyObject = (v: unknown) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0;
const hasKey = (v: unknown, k: string) =>
  v !== null && typeof v === 'object' && k in (v as object);

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
  ok ? pass++ : fail++;
}

(async () => {
  console.log(`HyPaper: ${BASE}   wallet: ${WALLET}\n`);

  // 1. Refused user-scoped types → typed empty (array)
  for (const type of ['portfolio', 'userFunding', 'userNonFundingLedgerUpdates',
                       'userTwapSliceFills', 'twapHistory']) {
    const v = await post(BASE, { type, user: WALLET });
    check(`${type} refused → []`, isEmptyArray(v), `got ${JSON.stringify(v).slice(0, 80)}`);
  }

  // 1b. Refused object-shaped types → {}
  for (const type of ['userFees', 'activeAssetData']) {
    const v = await post(BASE, { type, user: WALLET, coin: 'BTC' });
    check(`${type} refused → {}`, isEmptyObject(v), `got ${JSON.stringify(v).slice(0, 80)}`);
  }

  // 1c. Unknown future user type → fail-safe [] (never proxied)
  {
    const v = await post(BASE, { type: 'someBogusUserTypeV9', user: WALLET });
    check('unknown user type → [] (no proxy)', isEmptyArray(v), `got ${JSON.stringify(v).slice(0, 80)}`);
  }

  // 2. DEFINITIVE: portfolio. HL returns a non-empty skeleton; HyPaper [].
  {
    const hl = await post(HL, { type: 'portfolio', user: WALLET });
    const paper = await post(BASE, { type: 'portfolio', user: WALLET });
    const hlNonEmpty = Array.isArray(hl) && hl.length > 0;
    check('portfolio NOT proxied (definitive)',
      isEmptyArray(paper) && hlNonEmpty,
      hlNonEmpty
        ? `HL returned ${(hl as unknown[]).length} periods, HyPaper returned [] → proxy refused ✓`
        : `inconclusive: HL also returned empty (${JSON.stringify(hl).slice(0, 60)})`);
  }

  // 3. Market/reference unknown (no user) STILL proxies → real HL shape.
  {
    const v = await post(BASE, { type: 'spotMeta' });
    check('spotMeta (market) still proxied',
      hasKey(v, 'tokens') && hasKey(v, 'universe'),
      `keys: ${v && typeof v === 'object' ? Object.keys(v as object).join(',') : v}`);
  }

  // 4. PROXY_ANYWAY user type passes through → HL object shape, not [].
  {
    const v = await post(BASE, { type: 'spotClearinghouseState', user: WALLET });
    check('spotClearinghouseState passthrough (PROXY_ANYWAY)',
      hasKey(v, 'balances'),
      `got ${JSON.stringify(v).slice(0, 80)}`);
  }

  // 5. Existing local handler unaffected → paper clearinghouseState.
  {
    const v = await post(BASE, { type: 'clearinghouseState', user: WALLET });
    check('clearinghouseState still local paper state',
      hasKey(v, 'marginSummary') && hasKey(v, 'assetPositions'),
      `keys: ${v && typeof v === 'object' ? Object.keys(v as object).join(',') : v}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
