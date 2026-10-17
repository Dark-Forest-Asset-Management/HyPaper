/**
 * Per-endpoint rate limiting that mirrors HL prod's published limits.
 *
 * HL's documented limits:
 *   /info     — 1200 requests / minute / IP
 *   /exchange — 1200 requests / minute / IP (HL also enforces a
 *                per-wallet "action buffer" anti-abuse layer; we
 *                don't replicate that since it's not relevant to
 *                paper trading)
 *   ws        — separate (handled in ws/server.ts)
 *
 * Each route family gets its OWN bucket so a burst on /info doesn't
 * eat /exchange's budget. Buckets are keyed by `${route}|${ip}` so
 * cross-route bursts are independent. /evm and /hypaper get the same
 * per-IP rate — there's no real-chain analogue to copy for those,
 * but 1200/min/IP is a sane parallel.
 */

import { createMiddleware } from 'hono/factory';
import { getConnInfo } from '@hono/node-server/conninfo';
import { config } from '../../config.js';

interface RateBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateBucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

/** The client IP as nginx reports it. nginx APPENDS the socket address to
 *  any X-Forwarded-For the client sent ($proxy_add_x_forwarded_for), so the
 *  only trustworthy hop is the RIGHTMOST one; keying on the whole header
 *  let a client rotate buckets per request by prefixing junk (HP-06).
 *  Without the header (direct / WS post tunnel) fall back to the socket. */
function clientIp(c: Parameters<Parameters<typeof createMiddleware>[0]>[0]): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const last = xff.split(',').pop()?.trim();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? 'anon';
  } catch {
    return 'anon';
  }
}

function makeRateLimit(routeFamily: string, perMinute: number) {
  return createMiddleware(async (c, next) => {
    const ip = clientIp(c);
    const key = `${routeFamily}|${ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + config.RATE_LIMIT_WINDOW_MS };
      buckets.set(key, bucket);
    }

    bucket.count++;

    c.header('X-RateLimit-Limit', perMinute.toString());
    c.header('X-RateLimit-Remaining', Math.max(0, perMinute - bucket.count).toString());
    c.header('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000).toString());

    if (bucket.count > perMinute) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    await next();
  });
}

// HL-aligned per-route limits. /info and /exchange match HL's
// published 1200/min/IP. /evm and /hypaper get the same parallel.
export const infoRateLimit     = makeRateLimit('info',     1200);
export const exchangeRateLimit = makeRateLimit('exchange', 1200);
export const evmRateLimit      = makeRateLimit('evm',      1200);
export const hypaperRateLimit  = makeRateLimit('hypaper',  config.RATE_LIMIT_MAX);

// Legacy shared-bucket middleware retained until callers migrate
// to the per-family ones above. Routes still using this share a
// single bucket — bursts on one will count against the others.
export const rateLimitMiddleware = makeRateLimit('shared', config.RATE_LIMIT_MAX);
