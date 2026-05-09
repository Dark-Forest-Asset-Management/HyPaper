import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
}

const envSchema = z.object({
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  HL_WS_URL: z.string().default('wss://api.hyperliquid.xyz/ws'),
  HL_API_URL: z.string().default('https://api.hyperliquid.xyz'),
  PORT: z.coerce.number().default(3000),
  DEFAULT_BALANCE: z.coerce.number().default(100_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WS_RECONNECT_MIN_MS: z.coerce.number().default(1000),
  WS_RECONNECT_MAX_MS: z.coerce.number().default(30000),
  // Match HL prod's documented IP rate limit: 1200 requests per minute
  // per IP (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits).
  // The previous default of 120/min was 10× stricter than HL and
  // tripped 429s on typical SPA polling (4 parallel /info requests
  // every 2 s ≈ 120/min, before any user-action /exchange requests).
  RATE_LIMIT_MAX: z.coerce.number().default(1200),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  FEES_ENABLED: z.coerce.boolean().default(true),
  FEE_RATE_TAKER: z.string().default('0.00035'),
  FEE_RATE_MAKER: z.string().default('0.0001'),
  FUNDING_ENABLED: z.coerce.boolean().default(true),
  FUNDING_INTERVAL_MS: z.coerce.number().default(28_800_000),
  // ── Chart-drawing snapshot indexer (HyperEVM) ────────────────
  // Reads SnapshotPublished / SnapshotBurned events from the chart-
  // snapshots ERC-721 contract on HyperEVM and mirrors the latest
  // (wallet, market) → uri mapping into Postgres for fast hydration
  // by the slushy frontend. Disabled by default so installs without
  // a deployed contract address don't fail at startup.
  CHART_DRAWINGS_INDEXER_ENABLED: z.coerce.boolean().default(false),
  HYPEREVM_RPC: z.string().default('https://rpc.hyperliquid.xyz/evm'),
  CHART_NFT_CONTRACT: z.string().optional(),
  CHART_NFT_DEPLOY_BLOCK: z.coerce.number().optional(),
  CHART_INDEXER_POLL_MS: z.coerce.number().default(5_000),
  // Hard cap on getLogs window per query. HyperEVM's RPC rejects
  // requests where toBlock - fromBlock + 1 > 1000 with `query exceeds
  // max block range 1000`. Use 999 (one under) so the inclusive-span
  // computation in the worker stays safely under the cap.
  CHART_INDEXER_MAX_BLOCK_RANGE: z.coerce.number().default(999),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
