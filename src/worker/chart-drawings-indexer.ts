/**
 * Chart-drawings snapshot NFT indexer.
 *
 * Mirrors the on-chain `SlushyChartSnapshots` (ERC-721 on HyperEVM)
 * into Postgres. Source of truth stays on-chain; this is a fast
 * read-cache so the slushy frontend can hydrate drawings without an
 * RPC round-trip per chart load.
 *
 * Approach: poll `eth_getLogs` for the contract's events at a steady
 * cadence (HyperEVM public RPC doesn't reliably support eth_subscribe
 * over WS, so we don't rely on it). Each pass:
 *   1. Read the last-scanned block from `indexer_checkpoints`.
 *   2. Fetch `currentBlock` from the RPC.
 *   3. Walk forward in chunks of `MAX_BLOCK_RANGE` (HyperEVM caps
 *      log queries at a few thousand blocks).
 *   4. Process each event:
 *        - SnapshotPublished → upsert into chart_drawings.
 *        - SnapshotBurned    → delete the matching row.
 *      The indexer treats SnapshotPublished as authoritative on
 *      conflict (last write wins by block_number).
 *   5. Update the checkpoint atomically with the row writes.
 *
 * On first start, backfills from the configured deploy block. On
 * subsequent starts, resumes from the saved checkpoint.
 */

import { ethers } from 'ethers';
import { eq, and } from 'drizzle-orm';
import { db } from '../store/db.js';
import { chartDrawings, indexerCheckpoints } from '../store/schema.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const INDEXER_NAME = 'chart-drawings';

// Minimal ABI fragment — only the events the indexer needs. Pasted
// from the contract source; keep in sync if the contract changes.
const INDEXER_ABI = [
  'event SnapshotPublished(address indexed user, bytes32 indexed marketHash, uint256 indexed tokenId, string market, string uri)',
  'event SnapshotBurned(address indexed user, bytes32 indexed marketHash, uint256 indexed tokenId, string market)',
] as const;

// Topic-zero hashes for both events. Computed once at startup so we
// can issue a single `eth_getLogs` per chunk with an OR-filter on
// topic[0], cutting the request count in half during backfill (the
// public HyperEVM RPC's rate limit makes 2× queries problematic).
const IFACE = new ethers.Interface(INDEXER_ABI);
const TOPIC_PUBLISHED = IFACE.getEvent('SnapshotPublished')!.topicHash;
const TOPIC_BURNED    = IFACE.getEvent('SnapshotBurned')!.topicHash;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Detect a rate-limit response from the public HyperEVM RPC. The
 *  error can arrive in TWO shapes depending on how ethers wraps it:
 *
 *    1. Direct JSON-RPC error:
 *       { error: { code: -32005, message: 'rate limited' } }
 *    2. BAD_DATA-wrapped (ethers couldn't even parse the response
 *       because the server returned `{ id: null, error: {...} }`):
 *       { code: 'BAD_DATA', value: [{ error: { code: -32005, ... } }] }
 *
 *  Cover both. */
const isRateLimitError = (err: unknown): boolean => {
  const e = err as {
    code?: string | number;
    error?: { code?: number; message?: string };
    value?: Array<{ error?: { code?: number; message?: string } }>;
  };
  if (e?.error?.code === -32005) return true;
  if (typeof e?.error?.message === 'string' && /rate limit/i.test(e.error.message)) return true;
  if (Array.isArray(e?.value)) {
    for (const entry of e.value) {
      if (entry?.error?.code === -32005) return true;
      if (typeof entry?.error?.message === 'string' && /rate limit/i.test(entry.error.message)) return true;
    }
  }
  return false;
};

interface DecodedPublished {
  kind: 'published';
  user: string;
  market: string;
  tokenId: bigint;
  uri: string;
  blockNumber: number;
  txHash: string;
}
interface DecodedBurned {
  kind: 'burned';
  user: string;
  market: string;
  tokenId: bigint;
  blockNumber: number;
  txHash: string;
}
type DecodedEvent = DecodedPublished | DecodedBurned;

export class ChartDrawingsIndexer {
  private provider: ethers.JsonRpcProvider | null = null;
  private contract: ethers.Contract | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private stopped = false;

  async start(): Promise<void> {
    if (!config.CHART_DRAWINGS_INDEXER_ENABLED) {
      logger.info('chart-drawings indexer disabled (set CHART_DRAWINGS_INDEXER_ENABLED=true to enable)');
      return;
    }
    if (!config.CHART_NFT_CONTRACT) {
      logger.warn('chart-drawings indexer: CHART_NFT_CONTRACT not set — refusing to start');
      return;
    }
    if (!config.CHART_NFT_DEPLOY_BLOCK) {
      logger.warn('chart-drawings indexer: CHART_NFT_DEPLOY_BLOCK not set — refusing to start');
      return;
    }

    // Pin the network so ethers doesn't fire `eth_chainId` on
    // construction (and retry it every 1 s when rate-limited). The
    // chain id is fixed at 999 for HyperEVM mainnet — no point
    // discovering it. `staticNetwork: true` also prevents periodic
    // re-discovery polls.
    this.provider = new ethers.JsonRpcProvider(
      config.HYPEREVM_RPC,
      { name: 'hyperevm', chainId: 999 },
      { staticNetwork: true },
    );
    this.contract = new ethers.Contract(config.CHART_NFT_CONTRACT, INDEXER_ABI, this.provider);

    // Seed checkpoint at deploy block on first run so the very first
    // pass starts at the contract's birth, not block 0 (which would
    // have HyperEVM choke on a multi-million-block range).
    const cp = await db.select().from(indexerCheckpoints).where(eq(indexerCheckpoints.name, INDEXER_NAME)).limit(1);
    if (cp.length === 0) {
      const seed = config.CHART_NFT_DEPLOY_BLOCK - 1;
      await db.insert(indexerCheckpoints).values({
        name: INDEXER_NAME,
        blockNumber: seed,
        updatedAt: Date.now(),
      });
      logger.info({ seed, contract: config.CHART_NFT_CONTRACT }, 'chart-drawings indexer: seeded checkpoint at deploy block - 1');
    }

    logger.info({
      contract: config.CHART_NFT_CONTRACT,
      rpc: config.HYPEREVM_RPC,
      pollMs: config.CHART_INDEXER_POLL_MS,
    }, 'chart-drawings indexer started');

    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('chart-drawings indexer stopped');
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().catch((err) => logger.error({ err }, 'chart-drawings indexer tick failed'));
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      await this.scanOnce();
    } catch (err) {
      // Most failures here are transient RPC hiccups (e.g. the
      // "invalid block height" issue we saw during initial test).
      // Log and retry on the next interval.
      logger.warn({ err }, 'chart-drawings indexer: scan failed, will retry');
    } finally {
      this.polling = false;
      this.scheduleNext(config.CHART_INDEXER_POLL_MS);
    }
  }

  /** Wrapper around any RPC call that retries on rate-limit. Used by
   *  scanOnce for both `getBlockNumber` and `getLogs`. Capped at 5
   *  attempts; non-rate-limit errors propagate immediately. */
  private async withRateLimitRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const maxAttempts = 5;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try { return await fn(); }
      catch (err) {
        lastErr = err;
        if (!isRateLimitError(err)) throw err;
        const backoff = 500 * 2 ** attempt;        // 500ms, 1s, 2s, 4s, 8s
        logger.warn({ label, attempt, backoff }, 'chart-drawings indexer: rate-limited, backing off');
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  /** Single pass: fetch current head, walk from checkpoint+1 → head
   *  in MAX_BLOCK_RANGE chunks, process events, update checkpoint.
   *  Throttles between chunks so we don't drown the public RPC's
   *  rate limit during long backfills. */
  private async scanOnce(): Promise<void> {
    if (!this.provider || !this.contract) return;

    const latestBlock: number = await this.withRateLimitRetry<number>(
      'getBlockNumber',
      () => this.provider!.getBlockNumber(),
    );
    const cpRows = await db.select().from(indexerCheckpoints).where(eq(indexerCheckpoints.name, INDEXER_NAME)).limit(1);
    const lastScanned = cpRows[0]?.blockNumber ?? (config.CHART_NFT_DEPLOY_BLOCK! - 1);
    if (lastScanned >= latestBlock) return; // already caught up

    let from = lastScanned + 1;
    while (from <= latestBlock && !this.stopped) {
      const to = Math.min(from + config.CHART_INDEXER_MAX_BLOCK_RANGE - 1, latestBlock);
      const events = await this.fetchEvents(from, to);
      if (events.length > 0) {
        await this.applyEvents(events);
        logger.info({ from, to, count: events.length }, 'chart-drawings indexer: applied events');
      }
      // Advance the checkpoint REGARDLESS of whether there were
      // events in this window — otherwise we'd re-scan empty
      // ranges forever.
      await db
        .insert(indexerCheckpoints)
        .values({ name: INDEXER_NAME, blockNumber: to, updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: indexerCheckpoints.name,
          set: { blockNumber: to, updatedAt: Date.now() },
        });
      from = to + 1;
      // Throttle ~120 ms between chunks so a long backfill (~180
      // chunks for 178k blocks) stays under the public RPC's rate
      // cap. Skipped on the final chunk where `from > latestBlock`
      // — the loop exits without sleeping.
      if (from <= latestBlock) await sleep(120);
    }
  }

  /** Single getLogs per chunk, OR-filtered on both event topics.
   *  Halves request volume vs. one query per event type. Retries
   *  with exponential backoff on rate-limit errors (-32005). */
  private async fetchEvents(fromBlock: number, toBlock: number): Promise<DecodedEvent[]> {
    if (!this.provider || !config.CHART_NFT_CONTRACT) return [];
    const filter = {
      address: config.CHART_NFT_CONTRACT,
      fromBlock,
      toBlock,
      topics: [[TOPIC_PUBLISHED, TOPIC_BURNED]],   // OR-filter on topic[0]
    };
    const logs: ethers.Log[] = await this.withRateLimitRetry<ethers.Log[]>(
      `getLogs[${fromBlock}-${toBlock}]`,
      () => this.provider!.getLogs(filter),
    );

    const out: DecodedEvent[] = [];
    for (const log of logs) {
      const parsed = IFACE.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      if (parsed.name === 'SnapshotPublished') {
        out.push({
          kind: 'published',
          user: (parsed.args.user as string).toLowerCase(),
          market: parsed.args.market as string,
          tokenId: parsed.args.tokenId as bigint,
          uri: parsed.args.uri as string,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
        });
      } else if (parsed.name === 'SnapshotBurned') {
        out.push({
          kind: 'burned',
          user: (parsed.args.user as string).toLowerCase(),
          market: parsed.args.market as string,
          tokenId: parsed.args.tokenId as bigint,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
        });
      }
    }
    // getLogs returns logs in (block, txIndex, logIndex) order
    // already, so we just preserve that ordering. Within a re-publish
    // tx, the contract emits Burn(prior) BEFORE Publish(new) so the
    // applyEvents loop applies them in the right sequence.
    return out;
  }

  private async applyEvents(events: DecodedEvent[]): Promise<void> {
    for (const e of events) {
      if (e.kind === 'published') {
        // Upsert by (wallet, market). On re-publish the contract
        // emits Burn(prior) then Publish(new) in the same tx, so by
        // the time we apply this Publish row the prior row may or
        // may not exist (it'll have been deleted by the Burn we
        // applied earlier in this batch). Either way, an upsert
        // gives us the right end state.
        await db
          .insert(chartDrawings)
          .values({
            walletAddress: e.user,
            market: e.market,
            tokenId: e.tokenId.toString(),
            uri: e.uri,
            blockNumber: e.blockNumber,
            txHash: e.txHash,
            updatedAt: Date.now(),
          })
          .onConflictDoUpdate({
            target: [chartDrawings.walletAddress, chartDrawings.market],
            set: {
              tokenId: e.tokenId.toString(),
              uri: e.uri,
              blockNumber: e.blockNumber,
              txHash: e.txHash,
              updatedAt: Date.now(),
            },
          });
      } else {
        // Burn — delete the row scoped to (wallet, market). The
        // contract enforces one snapshot per pair so this matches at
        // most one row.
        await db
          .delete(chartDrawings)
          .where(and(
            eq(chartDrawings.walletAddress, e.user),
            eq(chartDrawings.market, e.market),
          ));
      }
    }
  }
}
