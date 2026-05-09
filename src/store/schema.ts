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

// ── Chart-drawing snapshot NFT indexer ─────────────────────────────
// Mirrors the on-chain SlushyChartSnapshots ERC-721's per-(wallet,
// market) snapshot mapping into Postgres so the slushy frontend can
// hydrate a user's drawings without doing a chain RPC round-trip on
// every chart load. Source of truth is on-chain; this table is a
// cache fed by the indexer worker (see worker/chart-drawings-indexer).
export const chartDrawings = pgTable('chart_drawings', {
  walletAddress: text('wallet_address').notNull(),  // 0x… lowercased
  market: text('market').notNull(),
  tokenId: text('token_id').notNull(),              // bigint as string
  uri: text('uri').notNull(),                        // encrypted envelope or IPFS pointer
  blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
  txHash: text('tx_hash').notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  // Composite primary key: one snapshot per (wallet, market) — exactly
  // what the contract enforces on-chain via currentSnapshotOf.
  primaryKey({ columns: [t.walletAddress, t.market] }),
  index('chart_drawings_wallet_idx').on(t.walletAddress),
  index('chart_drawings_token_idx').on(t.tokenId),
]);

// Indexer cursor — last block successfully scanned by a given indexer.
// Used by the chart-drawings indexer to resume from where it left off
// across HyPaper restarts.
export const indexerCheckpoints = pgTable('indexer_checkpoints', {
  name: text('name').primaryKey(),
  blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

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
