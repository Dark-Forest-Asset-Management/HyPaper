import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { config } from './config.js';
import { connectRedis, disconnectRedis } from './store/redis.js';
import { connectDb, disconnectDb } from './store/db.js';
import { startPgSink } from './store/pg-sink.js';
import { Worker, eventBus } from './worker/index.js';
import { app } from './api/server.js';
import { logger } from './utils/logger.js';
import { HyPaperWsServer } from './ws/server.js';

let worker: Worker;
let wsServer: HyPaperWsServer;

async function main() {
  logger.info('Starting HyPaper backend...');

  // Connect to Redis
  await connectRedis();
  logger.info('Redis connected');

  // Connect to Postgres
  await connectDb();

  // Start worker (fetches market data, connects WS)
  worker = new Worker();
  await worker.start();

  // Attach Postgres sink (async event listeners)
  startPgSink(eventBus);

  // Start HTTP server
  const httpServer = serve({
    fetch: app.fetch,
    port: config.PORT,
  }, (info) => {
    logger.info({ port: info.port }, 'HyPaper server running');
  }) as Server;

  // Attach WebSocket server
  wsServer = new HyPaperWsServer(httpServer, eventBus);
}

async function shutdown() {
  logger.info('Shutting down...');
  wsServer?.close();
  worker?.stop();
  await disconnectDb();
  await disconnectRedis();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
