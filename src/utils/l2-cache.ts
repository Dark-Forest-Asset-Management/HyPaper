import { config } from '../config.js';
import { logger } from './logger.js';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';

export interface L2Level {
  px: string;
  sz: string;
  n: number;
}

export interface HlL2Book {
  coin: string;
  levels: [L2Level[], L2Level[]]; // [bids, asks]
  time: number;
}

interface CacheEntry {
  book: HlL2Book;
  ts: number;
}

const CACHE_TTL_MS = 2000;
// Max age of a WS-pushed L2 book in Redis we'll trust before falling back to
// HTTP. The worker subscribes l2Book over WS for coins with open orders, so
// the book is normally <1s old; 5s tolerates a brief WS gap.
const REDIS_L2_MAX_AGE_MS = 5000;
// Hard cap on the HTTP fallback fetch. CRITICAL: getL2Book is awaited inside
// the matcher's serial order loop (order-matcher.ts matchOpenOrders), so a
// slow fetch blocks evaluation of every other order — including trigger
// orders (stop-loss / take-profit). Under Node 26's undici a stale-keepalive
// connection to HL public can hang the default 10s, which froze the matcher
// 10s at a time. Bounding it at 1s guarantees the matcher (and stops) can
// never starve: on timeout we return null and the caller fills at fallback mid.
const HTTP_FETCH_TIMEOUT_MS = 1000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<HlL2Book | null>>();

/** Read a WS-pushed L2 book from Redis (populated by price-updater's l2Book
 *  handler when the worker is subscribed to this coin). Returns null when
 *  absent or staler than REDIS_L2_MAX_AGE_MS. This is the normal path — no
 *  HTTP, no timeout risk. */
async function readL2FromRedis(coin: string): Promise<HlL2Book | null> {
  try {
    const raw = await redis.get(KEYS.MARKET_L2(coin));
    if (!raw) return null;
    const book = JSON.parse(raw) as HlL2Book;
    if (!book || !Array.isArray(book.levels)) return null;
    if (Date.now() - (book.time ?? 0) > REDIS_L2_MAX_AGE_MS) return null;
    return book;
  } catch {
    return null;
  }
}

async function fetchL2Book(coin: string): Promise<HlL2Book | null> {
  try {
    const res = await fetch(`${config.HL_API_URL}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'l2Book', coin }),
      // Hard timeout so a stale undici keepalive connection can't hang the
      // matcher. AbortSignal.timeout rejects the fetch; caught below → null.
      signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ coin, status: res.status }, 'L2 book fetch failed');
      return null;
    }
    const data = (await res.json()) as { levels: [[{ px: string; sz: string; n: number }], [{ px: string; sz: string; n: number }]] };
    return {
      coin,
      levels: data.levels as [L2Level[], L2Level[]],
      time: Date.now(),
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message, coin }, 'L2 book fetch error');
    return null;
  }
}

export async function getL2Book(coin: string): Promise<HlL2Book | null> {
  // 1. Prefer the WS-pushed book in Redis — no HTTP, no timeout risk. This is
  //    the normal path for any coin with an open order (worker subscribes its
  //    l2Book over WS).
  const fromWs = await readL2FromRedis(coin);
  if (fromWs) return fromWs;

  // 2. In-process HTTP cache (covers coins not WS-subscribed, e.g. one-shot
  //    market orders on a never-traded coin).
  const cached = cache.get(coin);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.book;
  }

  // 3. HTTP fallback, deduplicated + hard-timeout-bounded (see fetchL2Book).
  const existing = inflight.get(coin);
  if (existing) return existing;

  const promise = fetchL2Book(coin).then((book) => {
    inflight.delete(coin);
    if (book) {
      cache.set(coin, { book, ts: Date.now() });
    }
    return book;
  });

  inflight.set(coin, promise);
  return promise;
}
