import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { exchangeRouter } from './routes/exchange.js';
import { infoRouter } from './routes/info.js';
import { hypaperRouter } from './routes/hypaper.js';
import { evmRouter } from './routes/evm.js';
import { consentRouter } from './routes/consent.js';
import { logger } from '../utils/logger.js';

export const app = new Hono();

// Global middleware
app.use('*', cors());

// Global error handler
app.onError((err, c) => {
  if (err instanceof SyntaxError && err.message.includes('JSON')) {
    return c.json({ error: 'Invalid or missing JSON body' }, 400);
  }
  logger.error({ err }, 'Unhandled error');
  return c.json({ error: 'Internal server error' }, 500);
});

// Health check
app.get('/health', (c) => c.json({ status: 'ok', time: Date.now() }));

// Basic response for the bare API domain
app.get('/', (c) => c.json({
  status: 'ok',
  service: 'hypaper-api',
  endpoints: ['/health', '/info', '/exchange', '/hypaper', '/evm'],
}));

// Helpful response for wrong method
const postOnlyMsg = { error: 'This endpoint only accepts POST with a JSON body. See: POST /info {"type":"allMids"}' };
app.get('/info', (c) => c.json(postOnlyMsg, 405));
app.get('/exchange', (c) => c.json(postOnlyMsg, 405));
app.get('/hypaper', (c) => c.json(postOnlyMsg, 405));
app.get('/evm', (c) => c.json({ error: 'POST JSON-RPC required' }, 405));

// Rate limiting for API routes. /evm gets the same limiter — wallets
// fan out a few RPC requests per page load (chainId, getBalance,
// getBlockNumber, plus reads), and we want consistent shaping.
app.use('/exchange', rateLimitMiddleware);
app.use('/info', rateLimitMiddleware);
app.use('/hypaper', rateLimitMiddleware);
app.use('/evm', rateLimitMiddleware);

// Routes
app.route('/exchange', exchangeRouter);
app.route('/info', infoRouter);
app.route('/hypaper', hypaperRouter);
app.route('/evm', evmRouter);
// GDPR consent audit log — no rate limit (each visitor fires once per
// policy version, ~once a year). Endpoint records hashed-IP + policy
// version + per-category decision via the pg sink.
app.route('/consent', consentRouter);
