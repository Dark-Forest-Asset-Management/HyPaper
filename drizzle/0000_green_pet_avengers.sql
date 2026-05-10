-- Bootstrap migration: claims the existing prod schema (users, orders,
-- fills) as already-applied without recreating those tables, and adds
-- the chart-drawings indexer cache + checkpoint tables.
--
-- Drizzle will mark this migration as applied in `__drizzle_migrations`
-- on first run. The snapshot file under drizzle/meta/ still describes
-- the FULL target schema, so future `db:generate` calls diff correctly
-- against subsequent schema edits.
CREATE TABLE "chart_drawings" (
	"wallet_address" text NOT NULL,
	"market" text NOT NULL,
	"token_id" text NOT NULL,
	"uri" text NOT NULL,
	"block_number" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "chart_drawings_wallet_address_market_pk" PRIMARY KEY("wallet_address","market")
);
--> statement-breakpoint
CREATE TABLE "indexer_checkpoints" (
	"name" text PRIMARY KEY NOT NULL,
	"block_number" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chart_drawings_wallet_idx" ON "chart_drawings" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "chart_drawings_token_idx" ON "chart_drawings" USING btree ("token_id");
