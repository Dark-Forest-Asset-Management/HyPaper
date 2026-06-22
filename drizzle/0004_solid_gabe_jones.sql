-- Liquidation engine tables (liquidation_events, liquidator_vault).
--
-- Also (re)declares funding + ledger_updates: these were added to schema.ts via
-- an earlier `db:push` without a registered migration, so the migration journal
-- had drifted behind the live schema. They're included here so a fresh DB built
-- purely from migrations is complete.
--
-- Every statement is IDEMPOTENT (IF NOT EXISTS / guarded ADD CONSTRAINT) so this
-- is safe to apply to an environment that already has some of these objects
-- (prod has funding/ledger_updates but not the liquidation tables; dev was
-- db:push'd with all of them; a fresh DB has none).

CREATE TABLE IF NOT EXISTS "funding" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "funding_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"time" bigint NOT NULL,
	"coin" text NOT NULL,
	"usdc" text NOT NULL,
	"szi" text NOT NULL,
	"funding_rate" text NOT NULL,
	"n_samples" integer,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_updates" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_updates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"time" bigint NOT NULL,
	"hash" text NOT NULL,
	"delta_type" text NOT NULL,
	"usdc" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "liquidation_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "liquidation_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"asset" integer NOT NULL,
	"coin" text NOT NULL,
	"szi" text NOT NULL,
	"mark_px" text NOT NULL,
	"entry_px" text NOT NULL,
	"leverage" integer NOT NULL,
	"margin_type" text NOT NULL,
	"amount_recovered" text NOT NULL,
	"margin_lost" text NOT NULL,
	"liquidation_type" text NOT NULL,
	"time" bigint NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "liquidator_vault" (
	"id" integer PRIMARY KEY NOT NULL,
	"vault_address" text NOT NULL,
	"total_collected" text DEFAULT '0' NOT NULL,
	"last_updated" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "funding" ADD CONSTRAINT "funding_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ledger_updates" ADD CONSTRAINT "ledger_updates_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "liquidation_events" ADD CONSTRAINT "liquidation_events_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "funding_user_time_idx" ON "funding" USING btree ("user_id","time");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_user_time_idx" ON "ledger_updates" USING btree ("user_id","time");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "liq_events_user_time_idx" ON "liquidation_events" USING btree ("user_id","time");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "liq_events_coin_idx" ON "liquidation_events" USING btree ("coin");
