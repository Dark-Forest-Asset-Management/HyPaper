CREATE TABLE "asset_margin_table" (
	"coin" text PRIMARY KEY NOT NULL,
	"margin_table_id" integer,
	"max_leverage" integer NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "margin_tables" (
	"margin_table_id" integer PRIMARY KEY NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tiers_json" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "twap_history" RENAME COLUMN "status" TO "state";--> statement-breakpoint
ALTER TABLE "twap_history" RENAME COLUMN "finished_at" TO "event_at";--> statement-breakpoint
DROP INDEX "twap_history_twap_id_idx";--> statement-breakpoint
DROP INDEX "twap_history_user_id_idx";--> statement-breakpoint
ALTER TABLE "twap_history" ADD COLUMN "executed_ntl" text NOT NULL;--> statement-breakpoint
ALTER TABLE "twap_history" ADD COLUMN "randomize" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "twap_history" ADD COLUMN "terminal_reason" text;--> statement-breakpoint
ALTER TABLE "twap_history" ADD COLUMN "placement_timestamp" bigint NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "twap_history_twap_id_state_idx" ON "twap_history" USING btree ("twap_id","state");--> statement-breakpoint
CREATE INDEX "twap_history_user_id_idx" ON "twap_history" USING btree ("user_id","event_at");