import { pgTable, text, integer, bigint, boolean, index, primaryKey } from 'drizzle-orm/pg-core';

// ---------- Enums as text (matching TS union types) ----------

export const users = pgTable('users', {
  userId: text('user_id').primaryKey(),
  balance: text('balance').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const orders = pgTable('orders', {
  oid: integer('oid').primaryKey(),
  cloid: text('cloid'),
  userId: text('user_id').notNull().references(() => users.userId),
  asset: integer('asset').notNull(),
  coin: text('coin').notNull(),
  isBuy: boolean('is_buy').notNull(),
  sz: text('sz').notNull(),
  limitPx: text('limit_px').notNull(),
  orderType: text('order_type').notNull(), // 'limit' | 'trigger'
  tif: text('tif').notNull(), // 'Gtc' | 'Ioc' | 'Alo'
  reduceOnly: boolean('reduce_only').notNull(),
  triggerPx: text('trigger_px'),
  tpsl: text('tpsl'), // 'tp' | 'sl'
  isMarket: boolean('is_market'),
  grouping: text('grouping').notNull(), // 'na' | 'normalTpsl' | 'positionTpsl'
  status: text('status').notNull(), // 'open' | 'filled' | 'cancelled' | 'triggered' | 'rejected'
  filledSz: text('filled_sz').notNull(),
  avgPx: text('avg_px').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => [
  index('orders_user_id_idx').on(table.userId),
  index('orders_user_id_status_idx').on(table.userId, table.status),
  index('orders_coin_idx').on(table.coin),
]);

// ── Chart-drawing snapshot NFT (paper-mode chain emulation) ────────
// HyPaper exposes a HyperEVM-shaped JSON-RPC at /evm so slushy can use
// a single viem client in both paper + live modes. The state below
// mirrors the on-chain SlushyChartSnapshots contract's storage —
// `chartDrawings` IS the contract's `currentSnapshotOf` + `tokenURI`
// + `marketOf` mappings; `chainEvents` is the event log for
// `eth_getLogs`; `chainCounters` holds incrementing token id + block
// number to match real-chain behaviour.
export const chartDrawings = pgTable('chart_drawings', {
  walletAddress: text('wallet_address').notNull(),  // 0x… lowercased
  market: text('market').notNull(),
  tokenId: text('token_id').notNull(),               // bigint as string — actual NFT id
  uri: text('uri').notNull(),                         // encrypted envelope (slushy:1:…)
  blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
  txHash: text('tx_hash').notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  // Composite primary key: one snapshot per (wallet, market) —
  // exactly what the contract enforces via currentSnapshotOf.
  primaryKey({ columns: [t.walletAddress, t.market] }),
  index('chart_drawings_wallet_idx').on(t.walletAddress),
  index('chart_drawings_token_idx').on(t.tokenId),
]);

// Event log rows for eth_getLogs. Topic 0 = event signature hash;
// topic 1..3 = indexed args. `data` carries non-indexed args, ABI-
// encoded. Mirrors what HyperEVM would return for the same query.
export const chainEvents = pgTable('chain_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
  address: text('address').notNull(),                 // contract address (lowercase 0x…)
  topic0: text('topic0').notNull(),                   // event sig hash
  topic1: text('topic1'),                             // indexed arg 1 (or null)
  topic2: text('topic2'),                             // indexed arg 2
  topic3: text('topic3'),                             // indexed arg 3
  data: text('data').notNull(),                       // ABI-encoded non-indexed args (0x…)
}, (t) => [
  index('chain_events_block_idx').on(t.blockNumber),
  index('chain_events_topic0_idx').on(t.topic0),
]);

// Single-row counter table holding the next NFT token id + the
// current chain head block number. Both increment monotonically.
// The contract's `_nextTokenId` lives here.
export const chainCounters = pgTable('chain_counters', {
  // Locking row — always 1. Use uniqueness so we can't accidentally
  // create a second counters row.
  id: integer('id').primaryKey(),
  nextTokenId: bigint('next_token_id', { mode: 'number' }).notNull().default(1),
  currentBlock: bigint('current_block', { mode: 'number' }).notNull().default(0),
});

// GDPR consent audit trail. Each row is one accept/decline decision
// made by a slushy user. The IP is SHA-256-hashed before insert (raw
// IP is PII) — combined with the user-agent it provides reasonable
// proof of consent under Article 7(1) without retaining raw PII.
// Policy version is stored explicitly so we can re-prompt on policy
// changes and tie the decision to a specific document version.
export const consentRecords = pgTable('consent_records', {
  // Monotonic insert order — `now() * 1000` from the route handler. Acts
  // as both PK and rough timestamp. Conflicting inserts (same ms) get
  // bumped on insert.
  id: bigint('id', { mode: 'number' }).primaryKey(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  ipHash: text('ip_hash'),
  userAgent: text('user_agent'),
  policyVersion: integer('policy_version').notNull(),
  analytics: boolean('analytics').notNull(),
  advertising: boolean('advertising').notNull(),
  adPersonalization: boolean('ad_personalization').notNull(),
}, (table) => [
  index('consent_records_ts_idx').on(table.ts),
  index('consent_records_ip_hash_idx').on(table.ipHash),
]);

export const fills = pgTable('fills', {
  tid: integer('tid').primaryKey(),
  userId: text('user_id').notNull().references(() => users.userId),
  oid: integer('oid').notNull().references(() => orders.oid),
  coin: text('coin').notNull(),
  px: text('px').notNull(),
  sz: text('sz').notNull(),
  side: text('side').notNull(), // 'B' | 'A'
  time: bigint('time', { mode: 'number' }).notNull(),
  startPosition: text('start_position').notNull(),
  dir: text('dir').notNull(),
  closedPnl: text('closed_pnl').notNull(),
  hash: text('hash').notNull(),
  crossed: boolean('crossed').notNull(),
  fee: text('fee').notNull(),
  cloid: text('cloid'),
  feeToken: text('fee_token').notNull(),
}, (table) => [
  index('fills_user_id_time_idx').on(table.userId, table.time),
  index('fills_oid_idx').on(table.oid),
]);
