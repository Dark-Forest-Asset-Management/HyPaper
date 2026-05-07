import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import * as schema from './schema.js';

let sql: ReturnType<typeof postgres>;

export let db: ReturnType<typeof drizzle<typeof schema>>;

export async function connectDb(): Promise<void> {
  sql = postgres(config.DATABASE_URL, { max: 10 });
  db = drizzle(sql, { schema });

  // Verify the connection works
  try {
    await sql`SELECT 1`;
    logger.info('Postgres connected');
  } catch (err) {
    logger.fatal({ err }, 'Failed to connect to Postgres');
    throw new Error('Could not connect to Postgres. Check DATABASE_URL in your .env file.');
  }

  // Verify the schema exists. Without this check, missing tables surface
  // only at first write attempt — silently dropped by pg-sink's queue —
  // resulting in API-shaped responses backed by no persistence.
  const required = ['users', 'orders', 'fills'];
  const missing: string[] = [];
  for (const t of required) {
    const rows = await sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${t}
    `;
    if (rows.length === 0) missing.push(t);
  }
  if (missing.length > 0) {
    logger.fatal({ missing }, 'Postgres schema missing required tables');
    throw new Error(
      `Postgres schema is missing tables: ${missing.join(', ')}. ` +
      `Run "npm run db:push" to create them, then restart HyPaper.`,
    );
  }
  logger.info({ tables: required }, 'Postgres schema verified');
}

export async function disconnectDb(): Promise<void> {
  if (sql) {
    await sql.end();
    logger.info('Postgres disconnected');
  }
}
