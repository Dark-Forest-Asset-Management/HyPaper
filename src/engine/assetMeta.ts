import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { HlMeta } from '../types/hl.js';

// Asset-id decoding + per-asset meta lookups. Lives outside order.ts so the
// margin / liquidation math can read an asset's maxLeverage without pulling
// in the order engine (and, through it, the worker event bus).

// HL encodes sub-DEX asset ids as `100_000 + perpDexIdx*10_000 + universeIdx`.
// Anything < 100_000 is a main-DEX universe index. perpDexIdx aligns with
// the index in the array returned by /info perpDexs (where index 0 is null,
// index 1 is the first sub-DEX, etc.).
export const SUB_DEX_OFFSET = 100_000;
export const SUB_DEX_STRIDE = 10_000;

// HL spot assets are encoded as `10_000 + spotPairIndex`. The range
// [10_000, 100_000) is exclusively spot — main-DEX perp universe indices are
// in the low hundreds, and sub-DEX assets start at 100_000. Without this
// branch a spot asset id (e.g. 10_000 for the first pair) was misread as a
// main-DEX universe index and rejected as "Unknown asset".
export const SPOT_OFFSET = 10_000;

export function isSpotAsset(asset: number): boolean {
  return asset >= SPOT_OFFSET && asset < SUB_DEX_OFFSET;
}

export async function loadUniverseEntry(asset: number): Promise<{ universe: HlMeta['universe']; localIdx: number } | null> {
  if (asset < SUB_DEX_OFFSET) {
    const metaRaw = await redis.get(KEYS.MARKET_META);
    if (!metaRaw) return null;
    const meta: HlMeta = JSON.parse(metaRaw);
    if (asset < 0 || asset >= meta.universe.length) return null;
    return { universe: meta.universe, localIdx: asset };
  }
  // Sub-DEX
  const offset = asset - SUB_DEX_OFFSET;
  const dexIdx = Math.floor(offset / SUB_DEX_STRIDE);
  const localIdx = offset % SUB_DEX_STRIDE;
  const perpDexsRaw = await redis.get(KEYS.MARKET_PERPDEXS);
  if (!perpDexsRaw) return null;
  const perpDexs: Array<{ name: string } | null> = JSON.parse(perpDexsRaw);
  const dex = perpDexs[dexIdx];
  if (!dex || !dex.name) return null;
  const subMetaRaw = await redis.get(KEYS.MARKET_META_DEX(dex.name));
  if (!subMetaRaw) return null;
  const subMeta: HlMeta = JSON.parse(subMetaRaw);
  if (localIdx < 0 || localIdx >= subMeta.universe.length) return null;
  return { universe: subMeta.universe, localIdx };
}

/** Sub-dex scope for an asset id. Returns the dex name ('xyz', 'flx', …) for
 *  asset >= 100_000, or '' for native-perp and spot. Used by the rest of the
 *  engine to key per-dex balance / positions / orders. */
export async function scopeForAsset(asset: number): Promise<string> {
  if (asset < SUB_DEX_OFFSET) return '';
  const offset = asset - SUB_DEX_OFFSET;
  const dexIdx = Math.floor(offset / SUB_DEX_STRIDE);
  const perpDexsRaw = await redis.get(KEYS.MARKET_PERPDEXS);
  if (!perpDexsRaw) return '';
  const perpDexs: Array<{ name: string } | null> = JSON.parse(perpDexsRaw);
  return perpDexs[dexIdx]?.name ?? '';
}

/** Every HIP-3 dex name from the cached `/info perpDexs` list. */
export async function subDexNames(): Promise<string[]> {
  const raw = await redis.get(KEYS.MARKET_PERPDEXS);
  if (!raw) return [];
  const perpDexs: Array<{ name: string } | null> = JSON.parse(raw);
  return perpDexs.filter((d): d is { name: string } => !!d?.name).map((d) => d.name);
}

/** The asset's `maxLeverage` from the Redis copy of HL's `meta`, or null for
 *  spot / unknown assets. */
export async function cachedMaxLeverage(asset: number): Promise<number | null> {
  if (isSpotAsset(asset)) return null;
  const found = await loadUniverseEntry(asset);
  return found ? found.universe[found.localIdx].maxLeverage : null;
}

/** The asset's `maxLeverage` read live from public HL `/info meta` — the same
 *  `universe[idx].maxLeverage` field slushy's live mode reads (from
 *  metaAndAssetCtxs, also public HL) when a market is opened — so the cap
 *  tracks HL whenever HL changes it, not just at boot. The fresh meta replaces
 *  the Redis copy. If HL can't be reached, the Redis copy (seeded at boot) is
 *  used and the failure is logged. */
export async function fetchMaxLeverage(asset: number): Promise<number | null> {
  if (isSpotAsset(asset)) return null;
  const scope = await scopeForAsset(asset);
  try {
    const res = await fetch(`${config.HL_API_URL}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scope ? { type: 'meta', dex: scope } : { type: 'meta' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = (await res.json()) as HlMeta;
    if (!Array.isArray(meta?.universe)) throw new Error('meta response has no universe');
    await redis.set(scope ? KEYS.MARKET_META_DEX(scope) : KEYS.MARKET_META, JSON.stringify(meta));
  } catch (err) {
    logger.warn({ err, asset, scope }, 'meta refresh failed — using the cached maxLeverage');
  }
  return cachedMaxLeverage(asset);
}

/** HL's default leverage for an account that never set one: 20x cross, or the
 *  asset's maxLeverage when that is lower. Public HL activeAssetData for an
 *  untouched address (2026-10-19): XMR (max 5) → cross 5, BTC (max 40) →
 *  cross 20. */
const HL_DEFAULT_LEVERAGE = 20;

/** The user's leverage setting for `asset`, with HL's default when unset. */
export async function getLeverageSetting(userId: string, asset: number): Promise<{ leverage: number; isCross: boolean }> {
  const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
  const isCross = lev.isCross !== 'false';
  if (lev.leverage) return { leverage: parseInt(lev.leverage, 10), isCross };
  const max = await cachedMaxLeverage(asset);
  return { leverage: max != null ? Math.min(HL_DEFAULT_LEVERAGE, max) : HL_DEFAULT_LEVERAGE, isCross };
}
