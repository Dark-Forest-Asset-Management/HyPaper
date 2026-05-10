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
  // ── Chart-drawing snapshot chain emulation ──────────────────
  // HyPaper exposes a HyperEVM-shaped JSON-RPC at /evm so slushy can
  // use a single viem client in both paper and live modes. The
  // contract address below is the deployed contract on real HyperEVM
  // (chain 999); the emulator pretends it lives at the same address
  // so client code is identical across modes.
  CHART_NFT_CONTRACT: z.string().default('0x790Dd8d58a203Bb61768F68332bb7d897f452Ae3'),
  // Chain id reported by eth_chainId. 999 matches HyperEVM mainnet
  // so wallet typed-data signatures are interchangeable across modes.
  EVM_CHAIN_ID: z.coerce.number().default(999),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
