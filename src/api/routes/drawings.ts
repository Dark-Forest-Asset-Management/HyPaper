/**
 * /drawings — read-only endpoint serving the chart-drawings indexer's
 * cache. Mirrors the on-chain SlushyChartSnapshots state with
 * sub-second latency for the slushy frontend's chart-load hydration.
 *
 * GET /drawings?user=0x…             → all snapshots for `user`,
 *                                       grouped by market.
 * GET /drawings?user=0x…&market=XRP  → single snapshot for the
 *                                       (user, market) pair, or 404
 *                                       if none exists.
 *
 * Response shape (single):
 *   {
 *     walletAddress, market, tokenId, uri,
 *     blockNumber, txHash, updatedAt
 *   }
 *
 * Response shape (list):
 *   { snapshots: [<single>, ...] }
 *
 * The `uri` field is whatever was minted on-chain — typically a
 * `slushy:1:<nonce>:<ciphertext>` envelope produced by the slushy
 * frontend's drawingKey.ts. The endpoint is payload-agnostic.
 */

import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../store/db.js';
import { chartDrawings } from '../../store/schema.js';
import { logger } from '../../utils/logger.js';

export const drawingsRouter = new Hono();

drawingsRouter.get('/', async (c) => {
  const userRaw = c.req.query('user');
  const marketRaw = c.req.query('market');

  if (!userRaw) {
    return c.json({ error: 'Missing required query param: user' }, 400);
  }
  // Indexer stores wallet lowercased; mirror that so query is
  // case-insensitive at the API surface.
  if (!/^0x[0-9a-fA-F]{40}$/.test(userRaw)) {
    return c.json({ error: 'Invalid user address (expect 0x…40hex)' }, 400);
  }
  const user = userRaw.toLowerCase();

  try {
    if (marketRaw) {
      // Single (user, market) lookup.
      const rows = await db
        .select()
        .from(chartDrawings)
        .where(and(
          eq(chartDrawings.walletAddress, user),
          eq(chartDrawings.market, marketRaw),
        ))
        .limit(1);
      if (rows.length === 0) return c.json(null, 404);
      const r = rows[0];
      return c.json({
        walletAddress: r.walletAddress,
        market: r.market,
        tokenId: r.tokenId,
        uri: r.uri,
        blockNumber: r.blockNumber,
        txHash: r.txHash,
        updatedAt: r.updatedAt,
      });
    }
    // List mode — every market the user has a snapshot for. Order
    // by most-recently-updated so the frontend can render a
    // "recent activity" affordance if it wants.
    const rows = await db
      .select()
      .from(chartDrawings)
      .where(eq(chartDrawings.walletAddress, user))
      .orderBy(desc(chartDrawings.updatedAt));
    return c.json({
      snapshots: rows.map((r) => ({
        walletAddress: r.walletAddress,
        market: r.market,
        tokenId: r.tokenId,
        uri: r.uri,
        blockNumber: r.blockNumber,
        txHash: r.txHash,
        updatedAt: r.updatedAt,
      })),
    });
  } catch (err) {
    logger.error({ err, user, market: marketRaw }, 'drawings query failed');
    return c.json({ error: String(err) }, 500);
  }
});
