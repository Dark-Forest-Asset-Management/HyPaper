/**
 * Mark-price feed for engine features that must run on the MARK price
 * (trailing stops), not the mid.
 *
 * Why this exists: `market:mids` holds MIDS (allMids / activeAssetCtx.midPx).
 * HL evaluates trailing stops on the mark, and the two differ — in the HL
 * testnet probes `allMids` sat still for a minute while the mark/`best` kept
 * stepping. `market:ctx:{coin}.markPx` is the mark, but it is only written
 * when an `activeAssetCtx` frame for that coin arrives (HL requires a per-coin
 * subscription; the old coin-less one was rejected by HL and never delivered).
 *
 * Sources, in order:
 *   1. per-coin `activeAssetCtx` WS frames (PriceUpdater stamps `markTs`)
 *   2. HTTP `metaAndAssetCtxs` fallback — `refreshMarks()` — for coins whose
 *      mark is older than MARK_POLL_THRESHOLD_MS (WS silently dropped, sub not
 *      yet established, fresh boot, …)
 * Consumers must use `getFreshMark()`, which refuses marks older than
 * MARK_FRESH_MS so a stop can never fire off a stale price.
 *
 * Pure module (redis + fetch only) — no import of worker/index.ts, so it can
 * be used from both the engine and the worker without an import cycle.
 */

import type { EventEmitter } from 'node:events';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** A mark older than this is never evaluated against (trailing stops skip the tick). */
export const MARK_FRESH_MS = 15_000;
/** Older than this → the HTTP fallback refreshes it. */
export const MARK_POLL_THRESHOLD_MS = 5_000;

export interface MarkQuote { px: string; ts: number }

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** Latest stored mark for a coin (any age), or null if none/empty. */
export async function getMark(coin: string): Promise<MarkQuote | null> {
  const px = await redis.hget(KEYS.MARKET_CTX(coin), 'markPx');
  const ts = await redis.hget(KEYS.MARKET_CTX(coin), 'markTs');
  if (!px || !Number.isFinite(Number(px)) || Number(px) <= 0) return null;
  // A mark without a timestamp is the one-off boot seed — real, but of unknown age.
  return { px, ts: ts ? parseInt(ts, 10) || 0 : 0 };
}

/** Mark for a coin ONLY if it is fresh enough to trade on, else null. */
export async function getFreshMark(coin: string, now: number = Date.now()): Promise<string | null> {
  const m = await getMark(coin);
  if (!m || m.ts === 0 || now - m.ts > MARK_FRESH_MS) return null;
  return m.px;
}

/**
 * HTTP fallback: refresh the mark for every coin in `coins` whose stored mark
 * is stale (older than MARK_POLL_THRESHOLD_MS / missing). One
 * `metaAndAssetCtxs` request per dex ('' = native; HIP-3 coins look like
 * `xyz:AAPL` and need `dex: "xyz"`). Writes only `markPx` + `markTs` — it
 * deliberately does not touch `market:mids`. Returns the number refreshed.
 */
export async function refreshMarks(
  coins: Iterable<string>,
  now: number = Date.now(),
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<number> {
  const staleByDex = new Map<string, Set<string>>();
  for (const coin of new Set(coins)) {
    const m = await getMark(coin);
    if (m && m.ts !== 0 && now - m.ts <= MARK_POLL_THRESHOLD_MS) continue; // still fresh
    const colon = coin.indexOf(':');
    const dex = colon > 0 ? coin.slice(0, colon) : '';
    if (!staleByDex.has(dex)) staleByDex.set(dex, new Set());
    staleByDex.get(dex)!.add(coin);
  }

  let refreshed = 0;
  for (const [dex, wanted] of staleByDex) {
    try {
      const res = await fetchFn(`${config.HL_API_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const [meta, ctxs] = (await res.json()) as [
        { universe: Array<{ name: string }> },
        Array<{ markPx?: string }>,
      ];
      const pipeline = redis.pipeline();
      for (let i = 0; i < meta.universe.length && i < ctxs.length; i++) {
        const name = meta.universe[i].name;
        const markPx = ctxs[i]?.markPx;
        if (!wanted.has(name) || !markPx) continue;
        pipeline.hset(KEYS.MARKET_CTX(name), 'markPx', markPx, 'markTs', String(now));
        refreshed++;
      }
      await pipeline.exec();
    } catch (err) {
      logger.debug({ err: (err as Error).message, dex }, 'mark HTTP refresh failed');
    }
  }
  return refreshed;
}

/**
 * Wire the worker to the mark feed: (1) when the engine asks for a coin's mark (`markSub` on the bus, emitted at
 * trailing-stop placement) create its per-coin `activeAssetCtx` upstream subscription; (2) at boot, re-create the
 * subscriptions for every coin that already has an open trailing stop. Returns how many were restored. Kept out of
 * Worker.start so it can be tested without a websocket.
 */
export async function wireMarkSubscriptions(
  bus: EventEmitter,
  ensureSub: (sub: { type: string; coin: string }) => void,
): Promise<number> {
  bus.on('markSub', (e: { coin?: string }) => {
    if (e?.coin) ensureSub({ type: 'activeAssetCtx', coin: e.coin });
  });
  let restored = 0;
  for (const coin of await getTrailingCoins()) {
    ensureSub({ type: 'activeAssetCtx', coin });
    restored++;
  }
  return restored;
}

/** The worker's 5 s tick: HTTP-refresh the mark of every coin with an open trailing stop whose mark went stale. */
export async function refreshTrailingMarks(
  now: number = Date.now(),
  fetchFn?: Parameters<typeof refreshMarks>[2],
): Promise<number> {
  return refreshMarks(await getTrailingCoins(), now, fetchFn);
}

/** Distinct coins that currently have an open trailing stop. */
export async function getTrailingCoins(): Promise<Set<string>> {
  const coins = new Set<string>();
  for (const oidStr of await redis.smembers(KEYS.ORDERS_TRAILING)) {
    const coin = await redis.hget(KEYS.ORDER(parseInt(oidStr, 10)), 'coin');
    if (coin) coins.add(coin);
  }
  return coins;
}
