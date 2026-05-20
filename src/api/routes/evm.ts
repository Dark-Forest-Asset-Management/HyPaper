/**
 * /evm — JSON-RPC endpoint mirroring HyperEVM's RPC for the
 * SlushyChartSnapshots contract. Slushy's viem PublicClient and
 * WalletClient point here in paper mode and at rpc.hyperliquid.xyz/evm
 * in live mode — same code path either way.
 *
 * Accepts batched RPC arrays as well as single requests, since some
 * wallets / viem use cases batch a few calls together.
 */

import { Hono } from 'hono';
import { dispatch, type JsonRpcResponse } from '../../evm/dispatcher.js';

export const evmRouter = new Hono();

evmRouter.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); }
  catch {
    return c.json({
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: 'Parse error' },
    }, 400);
  }

  if (Array.isArray(body)) {
    // Batch request — process in parallel and return an array.
    const responses = await Promise.all(body.map((req) => dispatch(req)));
    return c.json(responses);
  }
  const response: JsonRpcResponse = await dispatch(body as Parameters<typeof dispatch>[0]);
  return c.json(response);
});
