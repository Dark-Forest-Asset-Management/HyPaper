ALTER TABLE "fills" ADD COLUMN "liquidation" jsonb;--> statement-breakpoint
ALTER TABLE "ledger_updates" ADD COLUMN "delta" jsonb;