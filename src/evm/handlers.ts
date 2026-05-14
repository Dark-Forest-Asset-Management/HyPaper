/**
 * Contract handlers — implement SlushyChartSnapshots' functions
 * against Postgres state. Mirrors the Solidity logic 1:1 so client
 * code (viem readContract / writeContract) sees identical behaviour
 * to the deployed contract on real HyperEVM.
 *
 * Read functions return ABI-encoded bytes for eth_call.
 * Write functions mutate PG and emit chain_events for eth_getLogs.
 *
 * Cross-reference with solidity/contracts/SlushyChartSnapshots.sol —
 * any contract change must update both places.
 */

import { eq, and, sql } from 'drizzle-orm';
import { ethers } from 'ethers';
import { db } from '../store/db.js';
import { chartDrawings, chainEvents, chainCounters } from '../store/schema.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { encodeResult, encodeEvent, keccakString, EVENT_TOPICS } from './coder.js';

const CONTRACT_ADDRESS = config.CHART_NFT_CONTRACT.toLowerCase();
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ── State helpers ────────────────────────────────────────────────

/** Atomically claim the next token id and bump current_block. Returns
 *  both because publish/burn need a token id AND a block number for
 *  the receipt + event log. Single UPDATE so concurrent calls get
 *  unique ids. */
async function nextTokenAndBlock(): Promise<{ tokenId: bigint; blockNumber: number }> {
  const result = await db.execute<{ token_id: string | number; current_block: string | number }>(sql`
    UPDATE chain_counters
       SET next_token_id = next_token_id + 1,
           current_block = current_block + 1
     WHERE id = 1
     RETURNING next_token_id - 1 AS token_id, current_block
  `);
  const r = result[0];
  if (!r) throw new Error('chain_counters row missing — migration not applied?');
  return {
    tokenId: BigInt(r.token_id),
    blockNumber: Number(r.current_block),
  };
}

/** Bump current_block only (for write txs that don't mint, and for
 *  block-number reads that should advance over time so wallets see
 *  fresh numbers). Returns the new block number. */
export async function tickBlock(): Promise<number> {
  const result = await db.execute<{ current_block: string | number }>(sql`
    UPDATE chain_counters
       SET current_block = current_block + 1
     WHERE id = 1
     RETURNING current_block
  `);
  return Number(result[0]?.current_block ?? 0);
}

/** Read current block without mutating. */
export async function readCurrentBlock(): Promise<number> {
  const rows = await db.select().from(chainCounters).where(eq(chainCounters.id, 1)).limit(1);
  return rows[0]?.currentBlock ?? 0;
}

/** Generate a deterministic-looking 32-byte tx hash. We don't run a
 *  real EVM so there's no canonical hash; we synthesize one from the
 *  raw signed tx bytes via keccak256. Wallets only need this to track
 *  receipts. */
function syntheticTxHash(rawTx: string): string {
  return ethers.keccak256(rawTx);
}

// ── View functions (eth_call) ────────────────────────────────────

/** balanceOf(address) — returns count of NFTs owned by `user`. */
export async function balanceOf(args: { user: string }): Promise<string> {
  const rows = await db.select().from(chartDrawings).where(eq(chartDrawings.walletAddress, args.user.toLowerCase()));
  return encodeResult('balanceOf', [BigInt(rows.length)]);
}

/** currentSnapshotOf(address, string) — the contract's primary read
 *  path; returns the token id (or 0 if none) for a (user, market). */
export async function currentSnapshotOf(args: { user: string; market: string }): Promise<string> {
  const rows = await db.select().from(chartDrawings).where(and(
    eq(chartDrawings.walletAddress, args.user.toLowerCase()),
    eq(chartDrawings.market, args.market),
  )).limit(1);
  const tokenId = rows[0]?.tokenId ? BigInt(rows[0].tokenId) : 0n;
  return encodeResult('currentSnapshotOf', [tokenId]);
}

/** tokenURI(uint256) — returns the encrypted envelope for a token.
 *  Reverts with TokenDoesNotExist if the token isn't minted. */
export async function tokenURI(args: { tokenId: bigint }): Promise<string> {
  const id = args.tokenId.toString();
  const rows = await db.select().from(chartDrawings).where(eq(chartDrawings.tokenId, id)).limit(1);
  if (rows.length === 0) throw revertWith('TokenDoesNotExist');
  return encodeResult('tokenURI', [rows[0].uri]);
}

/** ownerOf(uint256) — returns the address that owns the token.
 *  Reverts if the token doesn't exist. */
export async function ownerOf(args: { tokenId: bigint }): Promise<string> {
  const id = args.tokenId.toString();
  const rows = await db.select().from(chartDrawings).where(eq(chartDrawings.tokenId, id)).limit(1);
  if (rows.length === 0) throw revertWith('TokenDoesNotExist');
  return encodeResult('ownerOf', [rows[0].walletAddress]);
}

/** marketOf(uint256) — reverse mapping from token id → market string. */
export async function marketOf(args: { tokenId: bigint }): Promise<string> {
  const id = args.tokenId.toString();
  const rows = await db.select().from(chartDrawings).where(eq(chartDrawings.tokenId, id)).limit(1);
  if (rows.length === 0) throw revertWith('TokenDoesNotExist');
  return encodeResult('marketOf', [rows[0].market]);
}

/** name() / symbol() — ERC-721 metadata. */
export async function name(): Promise<string> {
  return encodeResult('name', ['Slushy Chart Snapshots']);
}
export async function symbol(): Promise<string> {
  return encodeResult('symbol', ['SLCS']);
}

/** supportsInterface(bytes4) — minimal ERC-165. Reports ERC-165 +
 *  ERC-721 + ERC-721 Metadata. */
export async function supportsInterface(args: { interfaceId: string }): Promise<string> {
  const supported = ['0x01ffc9a7', '0x80ac58cd', '0x5b5e139f']; // ERC-165, ERC-721, ERC-721 Metadata
  return encodeResult('supportsInterface', [supported.includes(args.interfaceId.toLowerCase())]);
}

// ── State-changing functions (eth_sendRawTransaction) ────────────

/** publish(market, uri) — mints a new snapshot for (sender, market),
 *  burning any prior snapshot for that pair atomically. Returns the
 *  new token id. */
export async function publish(
  sender: string,
  args: { market: string; uri: string },
  txHash: string,
): Promise<{ returnData: string; tokenId: bigint; blockNumber: number }> {
  const market = args.market.trim();
  if (!market) throw revertWith('EmptyMarket');
  if (!args.uri) throw revertWith('EmptyUri');

  const sender_lc = sender.toLowerCase();
  const { tokenId, blockNumber } = await nextTokenAndBlock();

  // Find any existing token for this (user, market) so we can emit
  // the burn event before overwriting.
  const existing = await db.select().from(chartDrawings).where(and(
    eq(chartDrawings.walletAddress, sender_lc),
    eq(chartDrawings.market, market),
  )).limit(1);

  if (existing.length > 0) {
    const oldTokenId = BigInt(existing[0].tokenId);
    await emitEvent('SnapshotBurned', {
      user: sender_lc, marketHash: keccakString(market), tokenId: oldTokenId, market,
    }, blockNumber, txHash, 0);
    await emitEvent('Transfer', {
      from: sender_lc, to: ZERO_ADDRESS, tokenId: oldTokenId,
    }, blockNumber, txHash, 1);
  }

  // Upsert the new row. Composite PK (wallet, market) means INSERT
  // becomes UPDATE if a row already exists.
  await db.insert(chartDrawings).values({
    walletAddress: sender_lc,
    market,
    tokenId: tokenId.toString(),
    uri: args.uri,
    blockNumber,
    txHash,
    updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: [chartDrawings.walletAddress, chartDrawings.market],
    set: {
      tokenId: tokenId.toString(),
      uri: args.uri,
      blockNumber,
      txHash,
      updatedAt: Date.now(),
    },
  });

  // Emit Transfer (mint) + SnapshotPublished events.
  const burnLogIndex = existing.length > 0 ? 2 : 0;
  await emitEvent('Transfer', {
    from: ZERO_ADDRESS, to: sender_lc, tokenId,
  }, blockNumber, txHash, burnLogIndex);
  await emitEvent('SnapshotPublished', {
    user: sender_lc, marketHash: keccakString(market), tokenId, market, uri: args.uri,
  }, blockNumber, txHash, burnLogIndex + 1);

  logger.info({ sender: sender_lc, market, tokenId: tokenId.toString() }, 'evm.publish minted');
  return {
    returnData: encodeResult('publish', [tokenId]),
    tokenId,
    blockNumber,
  };
}

/** deleteForMarket(market) — burns the sender's snapshot for `market`.
 *  Reverts with NoSnapshot if none exists. */
export async function deleteForMarket(
  sender: string,
  args: { market: string },
  txHash: string,
): Promise<{ returnData: string; tokenId: bigint; blockNumber: number }> {
  const market = args.market.trim();
  const sender_lc = sender.toLowerCase();
  const rows = await db.select().from(chartDrawings).where(and(
    eq(chartDrawings.walletAddress, sender_lc),
    eq(chartDrawings.market, market),
  )).limit(1);
  if (rows.length === 0) throw revertWith('NoSnapshot');

  const tokenId = BigInt(rows[0].tokenId);
  const blockNumber = await tickBlock();

  await db.delete(chartDrawings).where(and(
    eq(chartDrawings.walletAddress, sender_lc),
    eq(chartDrawings.market, market),
  ));

  await emitEvent('SnapshotBurned', {
    user: sender_lc, marketHash: keccakString(market), tokenId, market,
  }, blockNumber, txHash, 0);
  await emitEvent('Transfer', {
    from: sender_lc, to: ZERO_ADDRESS, tokenId,
  }, blockNumber, txHash, 1);

  logger.info({ sender: sender_lc, market, tokenId: tokenId.toString() }, 'evm.deleteForMarket burned');
  return { returnData: '0x', tokenId, blockNumber };
}

/** burn(tokenId) — only callable by the token's owner. Reverts NotOwner
 *  / TokenDoesNotExist accordingly. */
export async function burn(
  sender: string,
  args: { tokenId: bigint },
  txHash: string,
): Promise<{ returnData: string; blockNumber: number }> {
  const id = args.tokenId.toString();
  const sender_lc = sender.toLowerCase();
  const rows = await db.select().from(chartDrawings).where(eq(chartDrawings.tokenId, id)).limit(1);
  if (rows.length === 0) throw revertWith('TokenDoesNotExist');
  if (rows[0].walletAddress !== sender_lc) throw revertWith('NotOwner');

  const blockNumber = await tickBlock();
  const market = rows[0].market;
  await db.delete(chartDrawings).where(eq(chartDrawings.tokenId, id));

  await emitEvent('SnapshotBurned', {
    user: sender_lc, marketHash: keccakString(market), tokenId: args.tokenId, market,
  }, blockNumber, txHash, 0);
  await emitEvent('Transfer', {
    from: sender_lc, to: ZERO_ADDRESS, tokenId: args.tokenId,
  }, blockNumber, txHash, 1);

  return { returnData: '0x', blockNumber };
}

// ── Event emission ───────────────────────────────────────────────

async function emitEvent(
  eventName: keyof typeof EVENT_TOPICS,
  args: Record<string, unknown>,
  blockNumber: number,
  txHash: string,
  logIndex: number,
): Promise<void> {
  const { topics, data } = encodeEvent(eventName, args);
  await db.insert(chainEvents).values({
    blockNumber,
    txHash,
    logIndex,
    address: CONTRACT_ADDRESS,
    topic0: topics[0],
    topic1: topics[1] ?? null,
    topic2: topics[2] ?? null,
    topic3: topics[3] ?? null,
    data,
  });
}

// ── Reverts ──────────────────────────────────────────────────────

/** Build a custom-error revert payload. ethers will surface this to
 *  viem clients as a contract revert with the right error name. */
function revertWith(errorName: string): Error {
  const fragment = (() => {
    try {
      return (
        require_iface_get_error_for(errorName) ??
        null
      );
    } catch { return null; }
  })();
  const selector = fragment ?? '0x';
  const err = new Error(`execution reverted: custom error ${errorName}`);
  (err as Error & { data?: string; revertReason?: string }).data = selector;
  (err as Error & { revertReason?: string }).revertReason = errorName;
  return err;
}

// Lightweight selector lookup so revertWith doesn't need to import the
// full Interface twice. Computed once on module load.
const ERROR_SELECTORS: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const e of ['EmptyMarket', 'EmptyUri', 'NoSnapshot', 'NotOwner', 'TokenDoesNotExist']) {
    // keccak256("ErrorName()") first 4 bytes
    m[e] = ethers.id(`${e}()`).slice(0, 10);
  }
  return m;
})();

function require_iface_get_error_for(errorName: string): string | null {
  return ERROR_SELECTORS[errorName] ?? null;
}

/** Tx hash helper exported for the dispatcher's use. */
export { syntheticTxHash };
export const CONTRACT_ADDR = CONTRACT_ADDRESS;
