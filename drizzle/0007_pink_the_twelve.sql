CREATE TABLE "order_status_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_status_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"oid" integer NOT NULL,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"status_timestamp" bigint NOT NULL,
	"body" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_status_events_oid_status_uniq" ON "order_status_events" USING btree ("oid","status");--> statement-breakpoint
CREATE INDEX "order_status_events_user_ts_idx" ON "order_status_events" USING btree ("user_id","status_timestamp");