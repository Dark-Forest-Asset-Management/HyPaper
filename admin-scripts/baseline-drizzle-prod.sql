-- One-time baseline of drizzle migration tracking for an existing HyPaper DB
-- (prod) that was provisioned WITHOUT going through `drizzle-kit migrate`
-- (its tables were created via db:push / manual SQL, so __drizzle_migrations
-- is empty or absent).
--
-- It marks migrations 0000–0003 as ALREADY APPLIED so the deploy's
-- `npm run db:migrate` does not try to replay them (those are non-idempotent
-- CREATE TABLEs that would fail on the existing tables). 0004 is intentionally
-- NOT baselined — it's idempotent, so `db:migrate` will apply it and create the
-- liquidation tables.
--
-- created_at MUST equal each migration's journal `when`: drizzle decides what to
-- apply via  lastDbMigration.created_at < migration.when  (drizzle-orm pg-core
-- dialect). hash = sha256 of the migration .sql file (stored for integrity;
-- drizzle doesn't gate replay on it).
--
-- Idempotent: re-running is a no-op (guarded by NOT EXISTS on created_at).

CREATE SCHEMA IF NOT EXISTS "drizzle";

CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  "id" SERIAL PRIMARY KEY,
  "hash" text NOT NULL,
  "created_at" bigint
);

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
SELECT v.hash, v.created_at
FROM (VALUES
  ('d505fbe54ee1af0303dfc6cd9ef35a9caa3e8f23c5cdda734a7a3d37ded5b0f4'::text, 1778369276871::bigint), -- 0000_green_pet_avengers
  ('e513822c532ef68df8aa8180ad5ec8ba3853184b7f5f6b2ea36f337f8f160523',       1778376485467),         -- 0001_solid_gravity
  ('568a46beb0743003084d53e62db4b22ad99f4decc583bf691662b310e970de71',       1778389200000),         -- 0002_chain_emulation
  ('58038a74396168f745c0868e290c8bbab0646b0e9377a84792e314372090eb5f',       1778515431894)          -- 0003_yummy_professor_monster
) AS v(hash, created_at)
WHERE NOT EXISTS (
  SELECT 1 FROM "drizzle"."__drizzle_migrations" m WHERE m.created_at = v.created_at
);

SELECT id, created_at, left(hash, 12) || '…' AS hash
FROM "drizzle"."__drizzle_migrations"
ORDER BY created_at;
