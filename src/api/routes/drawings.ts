/**
 * /drawings — chart-drawings persistence for the slushy frontend.
 *
 * GET  /drawings?user=0x…             → all snapshots for `user`.
 * GET  /drawings?user=0x…&market=XRP  → single snapshot or 404.
 * POST /drawings/save                 → paper-mode write (EIP-712 signed).
 *
 * Read source: indexer-mirrored chain rows (source='chain') AND
 * paper-mode rows written via /save (source='paper'). Composite PK
 * (wallet, market) means at most one row per pair regardless of
 * source — paper writes overwrite chain reads and vice versa.
 *
 * Auth model for /save:
 *   The body carries an EIP-712 signature over (wallet, market,
 *   keccak256(uri), ts). The server recovers the signer with
 *   ethers.verifyTypedData and rejects unless recovered === wallet.
 *   `ts` must be within the SIGNATURE_TTL_MS window to limit replay.
 *
 * The `uri` field is whatever the frontend chooses to store —
 * typically a `slushy:1:<nonce>:<ciphertext>` envelope produced by
 * slushy/src/crypto/drawingKey.ts. The endpoint is payload-agnostic.
 */

import { Hono } from 'hono';
import { eq, and, desc, sql } from 'drizzle-orm';
import { ethers } from 'ethers';
import { db } from '../../store/db.js';
import { chartDrawings } from '../../store/schema.js';
import { logger } from '../../utils/logger.js';

// ── EIP-712 schema for /save ──────────────────────────────────────
// Domain matches slushy's drawingKey.ts KEY_DOMAIN by name+version
// so the wallet UI shows the same site identity for both the key-
// derivation prompt and the save prompt.
const SAVE_DOMAIN = {
  name: 'Slushy Chart Drawings',
  version: '1',
  chainId: 999,
} as const;

// ethers.verifyTypedData wants a mutable Record<string, TypedDataField[]>,
// so this isn't `as const` despite being conceptually static.
const SAVE_TYPES: Record<string, ethers.TypedDataField[]> = {
  SaveDrawing: [
    { name: 'wallet', type: 'address' },
    { name: 'market', type: 'string' },
    { name: 'uriHash', type: 'bytes32' },
    { name: 'ts', type: 'uint256' },
  ],
};

// Separate primaryType for the destroy action so a save signature can
// never be replayed as a delete (different EIP-712 hash).
const DESTROY_TYPES: Record<string, ethers.TypedDataField[]> = {
  DestroyDrawing: [
    { name: 'wallet', type: 'address' },
    { name: 'market', type: 'string' },
    { name: 'ts', type: 'uint256' },
  ],
};

// Signatures older than this are rejected. 5 min covers slow signing
// flows (hardware wallets, mobile) without leaving a meaningful replay
// window — paper-mode replay is low-impact anyway since the worst case
// is a user overwriting their own data with their own older snapshot.
const SIGNATURE_TTL_MS = 5 * 60 * 1000;

// Cap encrypted-envelope size to prevent abuse. A drawing snapshot of
// ~50 trendlines + a few fibs base64-encrypts to roughly 8-12KB; 64KB
// is comfortable headroom.
const MAX_URI_BYTES = 64 * 1024;

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

// POST /drawings/save — paper-mode write.
// Body: { wallet, market, uri, ts, signature }
//   wallet:    0x… 40 hex (must match recovered signer)
//   market:    string, e.g. "XRP" — pair key the frontend uses
//   uri:       opaque string (typically encrypted envelope)
//   ts:        epoch ms — recent (< SIGNATURE_TTL_MS old)
//   signature: 0x-prefixed EIP-712 signature over SaveDrawing
//
// On success: upserts row with source='paper' and null chain fields.
// Returns { ok: true, walletAddress, market, updatedAt }.
drawingsRouter.post('/save', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'Invalid or missing JSON body' }, 400); }

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Body must be a JSON object' }, 400);
  }
  const b = body as Record<string, unknown>;
  const wallet = typeof b.wallet === 'string' ? b.wallet : null;
  const market = typeof b.market === 'string' ? b.market.trim() : null;
  const uri = typeof b.uri === 'string' ? b.uri : null;
  const ts = typeof b.ts === 'number' ? b.ts : null;
  const signature = typeof b.signature === 'string' ? b.signature : null;

  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return c.json({ error: 'Invalid wallet (expect 0x…40hex)' }, 400);
  }
  if (!market || market.length === 0 || market.length > 32) {
    return c.json({ error: 'Invalid market (1-32 chars)' }, 400);
  }
  if (!uri || uri.length === 0) {
    return c.json({ error: 'Missing uri' }, 400);
  }
  if (Buffer.byteLength(uri, 'utf8') > MAX_URI_BYTES) {
    return c.json({ error: `uri too large (max ${MAX_URI_BYTES} bytes)` }, 413);
  }
  if (ts === null || !Number.isFinite(ts)) {
    return c.json({ error: 'Invalid ts (epoch ms)' }, 400);
  }
  const skew = Math.abs(Date.now() - ts);
  if (skew > SIGNATURE_TTL_MS) {
    return c.json({ error: `ts outside ${SIGNATURE_TTL_MS}ms window` }, 400);
  }
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature) || signature.length < 132) {
    return c.json({ error: 'Invalid signature' }, 400);
  }

  // Recover signer. ethers.verifyTypedData throws on malformed input.
  const uriHash = ethers.keccak256(ethers.toUtf8Bytes(uri));
  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(
      SAVE_DOMAIN,
      SAVE_TYPES,
      { wallet, market, uriHash, ts },
      signature,
    );
  } catch (err) {
    return c.json({ error: `Signature verify failed: ${(err as Error).message}` }, 400);
  }
  if (recovered.toLowerCase() !== wallet.toLowerCase()) {
    return c.json({
      error: 'Signature does not match wallet',
      recovered: recovered.toLowerCase(),
    }, 401);
  }

  const walletLc = wallet.toLowerCase();
  const updatedAt = Date.now();
  try {
    await db.insert(chartDrawings).values({
      walletAddress: walletLc,
      market,
      source: 'paper',
      tokenId: null,
      uri,
      blockNumber: null,
      txHash: null,
      updatedAt,
    }).onConflictDoUpdate({
      target: [chartDrawings.walletAddress, chartDrawings.market],
      set: {
        source: 'paper',
        tokenId: null,
        uri: sql`excluded.uri`,
        blockNumber: null,
        txHash: null,
        updatedAt: sql`excluded.updated_at`,
      },
    });
    logger.info({ wallet: walletLc, market, bytes: uri.length }, 'paper drawing saved');
    return c.json({ ok: true, walletAddress: walletLc, market, updatedAt });
  } catch (err) {
    logger.error({ err, wallet: walletLc, market }, 'paper drawing save failed');
    return c.json({ error: String(err) }, 500);
  }
});

// POST /drawings/destroy — paper-mode delete of the (wallet, market) row.
// Body: { wallet, market, ts, signature }
//   ts:        epoch ms — recent (< SIGNATURE_TTL_MS old)
//   signature: 0x-prefixed EIP-712 sig over DestroyDrawing(wallet, market, ts)
//
// Why POST not DELETE: most fetch/proxy stacks don't ship JSON bodies on
// DELETE requests cleanly. POST keeps the body shape consistent with /save.
//
// Real-mode (chain) rows that were mirrored by the indexer from a burn
// event will already be deleted via the indexer's normal flow — this
// endpoint is for paper rows. We don't restrict by source though: the
// authoritative source for chain rows is on-chain, so an authenticated
// destroy here would just be re-mirrored if the chain row still exists.
drawingsRouter.post('/destroy', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'Invalid or missing JSON body' }, 400); }

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Body must be a JSON object' }, 400);
  }
  const b = body as Record<string, unknown>;
  const wallet = typeof b.wallet === 'string' ? b.wallet : null;
  const market = typeof b.market === 'string' ? b.market.trim() : null;
  const ts = typeof b.ts === 'number' ? b.ts : null;
  const signature = typeof b.signature === 'string' ? b.signature : null;

  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return c.json({ error: 'Invalid wallet (expect 0x…40hex)' }, 400);
  }
  if (!market || market.length === 0 || market.length > 32) {
    return c.json({ error: 'Invalid market (1-32 chars)' }, 400);
  }
  if (ts === null || !Number.isFinite(ts)) {
    return c.json({ error: 'Invalid ts (epoch ms)' }, 400);
  }
  if (Math.abs(Date.now() - ts) > SIGNATURE_TTL_MS) {
    return c.json({ error: `ts outside ${SIGNATURE_TTL_MS}ms window` }, 400);
  }
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature) || signature.length < 132) {
    return c.json({ error: 'Invalid signature' }, 400);
  }

  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(
      SAVE_DOMAIN,
      DESTROY_TYPES,
      { wallet, market, ts },
      signature,
    );
  } catch (err) {
    return c.json({ error: `Signature verify failed: ${(err as Error).message}` }, 400);
  }
  if (recovered.toLowerCase() !== wallet.toLowerCase()) {
    return c.json({
      error: 'Signature does not match wallet',
      recovered: recovered.toLowerCase(),
    }, 401);
  }

  const walletLc = wallet.toLowerCase();
  try {
    const result = await db.delete(chartDrawings).where(and(
      eq(chartDrawings.walletAddress, walletLc),
      eq(chartDrawings.market, market),
    ));
    // drizzle-pg's delete() doesn't return rowCount in a portable way;
    // we treat both "had a row" and "didn't" as success since the
    // user's intent — make sure no row exists for (wallet, market) —
    // is satisfied either way.
    logger.info({ wallet: walletLc, market, result: String(result) }, 'paper drawing destroyed');
    return c.json({ ok: true, walletAddress: walletLc, market });
  } catch (err) {
    logger.error({ err, wallet: walletLc, market }, 'paper drawing destroy failed');
    return c.json({ error: String(err) }, 500);
  }
});
