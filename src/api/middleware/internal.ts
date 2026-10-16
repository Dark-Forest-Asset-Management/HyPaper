/**
 * Internal-caller gate for the two HyPaper surfaces that act on a paper
 * account WITHOUT an EIP-712 signature from that account's key:
 *
 *   • POST /exchange with `{ wallet, action }` and no signature — used by
 *     the slushy MCP server, which holds no user keys but has already
 *     verified wallet control via the signed MCP access token.
 *   • POST /hypaper `setBalance` / `resetAccount` — paper-only admin.
 *
 * Both were reachable from the public internet with nothing but a body
 * field naming the victim (2026-10-13 review, HP-01 / HP-03). The caller
 * now has to present the shared secret in `x-hypaper-internal`. nginx
 * never adds the header, the WS `post` tunnel forwards no headers, and
 * the secret only lives in HyPaper's and the MCP's `.env` on the same
 * host — so a browser can't reach either path.
 *
 * Unset INTERNAL_API_SECRET = both paths disabled outright (fail closed),
 * never "open for local tests".
 */
import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { config } from '../../config.js';

export const INTERNAL_HEADER = 'x-hypaper-internal';

export function isInternalRequest(c: Context): boolean {
  const secret = config.INTERNAL_API_SECRET;
  if (!secret) return false;
  const presented = c.req.header(INTERNAL_HEADER);
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
