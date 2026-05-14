CREATE TABLE "consent_records" (
	"id" bigint PRIMARY KEY NOT NULL,
	"ts" bigint NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"policy_version" integer NOT NULL,
	"analytics" boolean NOT NULL,
	"advertising" boolean NOT NULL,
	"ad_personalization" boolean NOT NULL
);
--> statement-breakpoint
CREATE INDEX "consent_records_ts_idx" ON "consent_records" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "consent_records_ip_hash_idx" ON "consent_records" USING btree ("ip_hash");