CREATE TABLE "twap_history" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "twap_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"twap_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"asset" integer NOT NULL,
	"coin" text NOT NULL,
	"is_buy" boolean NOT NULL,
	"reduce_only" boolean NOT NULL,
	"total_size" text NOT NULL,
	"executed_size" text NOT NULL,
	"minutes" integer NOT NULL,
	"status" text NOT NULL,
	"start_time" bigint NOT NULL,
	"end_time" bigint NOT NULL,
	"finished_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fills" ADD COLUMN "twap_id" integer;--> statement-breakpoint
ALTER TABLE "twap_history" ADD CONSTRAINT "twap_history_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "twap_history_user_id_idx" ON "twap_history" USING btree ("user_id","finished_at");--> statement-breakpoint
CREATE UNIQUE INDEX "twap_history_twap_id_idx" ON "twap_history" USING btree ("twap_id");--> statement-breakpoint
CREATE INDEX "fills_twap_id_idx" ON "fills" USING btree ("twap_id");