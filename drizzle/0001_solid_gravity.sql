ALTER TABLE "chart_drawings" ALTER COLUMN "token_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chart_drawings" ALTER COLUMN "block_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chart_drawings" ALTER COLUMN "tx_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chart_drawings" ADD COLUMN "source" text DEFAULT 'chain' NOT NULL;