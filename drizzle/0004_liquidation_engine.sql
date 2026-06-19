-- Migration: liquidation engine
-- Adds two tables:
--   liquidation_events  — one row per liquidation (full or partial close)
--   liquidator_vault    — single-row running total for the vault balance
--
-- Follows the same conventions as existing migrations:
--   • bigint timestamps stored as numbers (mode: 'number' in Drizzle schema)
--   • text for all USDC / price / size decimals (no float rounding)
--   • generatedAlwaysAsIdentity for auto-increment ids

-- ── liquidation_events ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "liquidation_events" (
  "id"                integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "user_id"           text NOT NULL REFERENCES "users"("user_id"),
  "asset"             integer NOT NULL,
  "coin"              text NOT NULL,
  "szi"               text NOT NULL,
  "mark_px"           text NOT NULL,
  "entry_px"          text NOT NULL,
  "leverage"          integer NOT NULL,
  "margin_type"       text NOT NULL,       -- 'cross' | 'isolated'
  "amount_recovered"  text NOT NULL,       -- USDC returned to user
  "margin_lost"       text NOT NULL,       -- maintenance margin consumed
  "liquidation_type"  text NOT NULL,       -- 'full' | 'partial'
  "time"              bigint NOT NULL,      -- unix ms
  "hash"              text NOT NULL
);

CREATE INDEX IF NOT EXISTS "liq_events_user_time_idx"
  ON "liquidation_events" ("user_id", "time");

CREATE INDEX IF NOT EXISTS "liq_events_coin_idx"
  ON "liquidation_events" ("coin");

-- ── liquidator_vault ────────────────────────────────────────────────────
-- Single row (id = 1 always). Use INSERT ... ON CONFLICT DO NOTHING
-- at application startup to seed the row.
CREATE TABLE IF NOT EXISTS "liquidator_vault" (
  "id"              integer PRIMARY KEY,           -- always 1
  "vault_address"   text NOT NULL,
  "total_collected" text NOT NULL DEFAULT '0',     -- running USDC total
  "last_updated"    bigint NOT NULL DEFAULT 0      -- unix ms
);
