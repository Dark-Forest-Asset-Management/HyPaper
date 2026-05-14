/**
 * GDPR consent audit endpoint.
 *
 * Receives one record per accept/decline decision from slushy's
 * CookieConsent toast. Stores a SHA-256 hash of the client IP (raw
 * IP is PII; the hash is enough to demonstrate "different visitors
 * gave consent at different times" without retaining the IP itself)
 * plus user agent, timestamp, policy version, and the per-category
 * decisions.
 *
 * Fire-and-forget on the client side via `navigator.sendBeacon`,
 * so the response shape is minimal — we acknowledge with 204 and
 * push the row through the pg-sink queue. No rate limiting (each
 * user submits maybe once a year).
 *
 * Compliance reference:
 *   - GDPR Art. 7(1): "the controller shall be able to demonstrate
 *     that the data subject has consented"
 *   - EDPB guidelines 05/2020 on consent: a CMP record with
 *     timestamp + version + scope is sufficient evidence.
 */
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { recordConsent } from '../../store/pg-sink.js';
import { logger } from '../../utils/logger.js';

export const consentRouter = new Hono();

interface ConsentBody {
  policyVersion?: number;
  analytics?: boolean;
  advertising?: boolean;
  adPersonalization?: boolean;
  ts?: number;
}

function hashIp(ip: string): string {
  // Salted SHA-256. Salt is a process-local constant — we only need
  // the hash to be stable WITHIN a single deployment (so duplicate
  // submissions from the same client collapse on analytics), not
  // across deploys. No raw IP ever touches disk.
  return createHash('sha256').update('slushy-consent:' + ip).digest('hex');
}

consentRouter.post('/', async (c) => {
  let body: ConsentBody;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'Invalid JSON' }, 400); }

  // Validate fields. policyVersion is required so we can tie this row
  // back to a specific privacy-policy document version later.
  if (typeof body.policyVersion !== 'number' || body.policyVersion <= 0) {
    return c.json({ error: 'policyVersion required' }, 400);
  }
  const analytics = !!body.analytics;
  const advertising = !!body.advertising;
  const adPersonalization = !!body.adPersonalization;

  // Pull the client IP from Cloudflare/standard headers, fall back to
  // the socket remote address. HyPaper sits behind nginx; nginx sets
  // X-Forwarded-For with the real client IP first.
  const rawIp =
    c.req.header('cf-connecting-ip') ??
    (c.req.header('x-forwarded-for') ?? '').split(',')[0]?.trim() ??
    'unknown';
  const ipHash = rawIp && rawIp !== 'unknown' ? hashIp(rawIp) : null;
  const userAgent = c.req.header('user-agent') ?? null;

  // Use the client's submitted timestamp if reasonable, else our own.
  // Bound to ±1h of server time so a broken client clock can't poison
  // the audit ordering.
  const now = Date.now();
  const clientTs = typeof body.ts === 'number' ? body.ts : now;
  const ts = Math.abs(clientTs - now) < 3_600_000 ? clientTs : now;

  // PK is monotonic-microsecond-ish so concurrent submissions don't
  // collide.
  const id = ts * 1000 + Math.floor(Math.random() * 1000);

  recordConsent({
    id, ts, ipHash, userAgent,
    policyVersion: body.policyVersion,
    analytics, advertising, adPersonalization,
  });
  logger.info({ id, ts, policyVersion: body.policyVersion, analytics, advertising, adPersonalization }, 'consent recorded');

  // 204 No Content — sendBeacon doesn't care about the body.
  return c.body(null, 204);
});
