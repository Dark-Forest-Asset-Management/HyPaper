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
  // L2 book transport. true (default): the worker subscribes l2Book over WS
  // and the matcher reads the book Redis-first. false: skip the subscription
  // so getL2Book falls back to HTTP /info polling (the original behavior). A
  // kill-switch to roll the WS path back without a redeploy — not a second
  // first-class mode. NOTE: can't use z.coerce.boolean() here — it treats any
  // non-empty string (incl. "false") as true — so parse explicitly.
  L2_WS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
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
  // ── Liquidation engine ───────────────────────────────────────
  // Vault address/key generated once via scripts/generate-liquidator-vault.ts.
  // Paper-mode only — this never touches real funds, it's just an identity
  // label for the vault's Redis/Postgres accounting (engine/liquidator-vault.ts).
  LIQUIDATOR_VAULT_ADDRESS: z.string().default(''),
  LIQUIDATOR_VAULT_PRIVATE_KEY: z.string().default(''),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;