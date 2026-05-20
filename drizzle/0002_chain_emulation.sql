-- Migration: chain emulation rework.
--
-- Rip the indexer scaffolding (we ARE the chain in paper mode now) and
-- swap chart_drawings to its always-required-fields shape so it reflects
-- actual contract storage rather than a chain-cache hybrid.
--
-- Adds chain_events (event log for eth_getLogs) and chain_counters
-- (next NFT id + current block).

-- 1) Drop the indexer cursor table — no more polling HyperEVM.
DROP TABLE IF EXISTS "indexer_checkpoints";--> statement-breakpoint

-- 2) Restore NOT-NULL on chain fields. They were nullable in 0001 to
--    allow paper-mode rows to skip them; now every row IS a chain
--    row (we ARE the chain), so they're always populated.
--
--    Wipe any existing rows with null chain fields first — they were
--    paper-mode rows that don't have a place in the new model.
DELETE FROM "chart_drawings"
  WHERE "token_id" IS NULL OR "block_number" IS NULL OR "tx_hash" IS NULL;
--> statement-breakpoint
ALTER TABLE "chart_drawings" ALTER COLUMN "token_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chart_drawings" ALTER COLUMN "block_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chart_drawings" ALTER COLUMN "tx_hash" SET NOT NULL;--> statement-breakpoint

-- 3) Drop the source column — no longer two sources, only "chain".
ALTER TABLE "chart_drawings" DROP COLUMN IF EXISTS "source";--> statement-breakpoint

-- 4) Event log table. eth_getLogs queries this directly. Topic 0 is the
--    event-signature hash; topics 1-3 are indexed args; data is the
--    ABI-encoded non-indexed args.
CREATE TABLE "chain_events" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "block_number" bigint NOT NULL,
  "tx_hash" text NOT NULL,
  "log_index" integer NOT NULL,
  "address" text NOT NULL,
  "topic0" text NOT NULL,
  "topic1" text,
  "topic2" text,
  "topic3" text,
  "data" text NOT NULL
);--> statement-breakpoint
CREATE INDEX "chain_events_block_idx" ON "chain_events" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "chain_events_topic0_idx" ON "chain_events" USING btree ("topic0");--> statement-breakpoint

-- 5) Single-row counter for next token id + current block. Seeded with
--    one row at id=1 so handlers don't have to special-case "no row".
CREATE TABLE "chain_counters" (
  "id" integer PRIMARY KEY,
  "next_token_id" bigint NOT NULL DEFAULT 1,
  "current_block" bigint NOT NULL DEFAULT 0
);--> statement-breakpoint
INSERT INTO "chain_counters" ("id", "next_token_id", "current_block")
  VALUES (1, 1, 0)
  ON CONFLICT (id) DO NOTHING;
