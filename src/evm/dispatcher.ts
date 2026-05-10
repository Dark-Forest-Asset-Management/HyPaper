/**
 * JSON-RPC method dispatcher. Maps eth_* and net_* requests to local
 * handlers backed by Postgres state. Behaviour intentionally matches
 * what real HyperEVM RPC returns so slushy can use the same viem
 * client in paper mode (this) and live mode (real chain).
 *
 * Methods implemented (the surface viem actually touches for our
 * read/write/balance flows):
 *
 *   eth_chainId              → 0x3e7 (999, same as live)
 *   eth_blockNumber          → tracked in chain_counters
 *   eth_getBalance           → constant huge value (paper users
 *                              never run out of gas)
 *   eth_gasPrice             → 0
 *   eth_estimateGas          → constant 250k
 *   eth_getCode              → returns 0x with length so wallets
 *                              know the address is a contract
 *   eth_getTransactionCount  → 0 (we don't enforce nonces in paper)
 *   eth_call                 → decode calldata → run view fn → encode
 *   eth_sendRawTransaction   → decode signed tx → recover signer →
 *                              run state-changing fn → emit events
 *   eth_getTransactionReceipt → success receipt with mocked logs
 *   eth_getLogs              → query chain_events
 *   eth_getBlockByNumber     → minimal block stub
 *   net_version              → "999"
 *   web3_clientVersion       → "HyPaper/1.0 (chain emulator)"
 *
 * Anything not in this list returns a JSON-RPC method-not-found
 * error so a stray RPC call surfaces a clear failure rather than
 * silently corrupting state.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { decodeCall, parseSignedTx } from './coder.js';
import * as h from './handlers.js';
import { eq, and, gte, lte, inArray, sql } from 'drizzle-orm';
import { db } from '../store/db.js';
import { chainEvents } from '../store/schema.js';

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string | null;
  method: string;
  params?: unknown[];
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

const CHAIN_ID_HEX = '0x' + config.EVM_CHAIN_ID.toString(16);
// Big enough that wallets never warn about insufficient gas.
// 1000 HYPE in wei (HYPE has 18 decimals like ETH).
const FAKE_BALANCE_WEI_HEX = '0x' + (BigInt(1000) * BigInt(10 ** 18)).toString(16);
const ZERO_HEX = '0x0';
const FAKE_GAS_LIMIT_HEX = '0x3d090'; // 250_000

export async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  try {
    const result = await handle(req);
    return { jsonrpc: '2.0', id: req.id, result };
  } catch (err) {
    const e = err as Error & { data?: unknown; code?: number };
    logger.warn({ method: req.method, err: e.message }, 'evm.dispatch error');
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: {
        code: e.code ?? -32000,
        message: e.message,
        ...(e.data ? { data: e.data } : {}),
      },
    };
  }
}

async function handle(req: JsonRpcRequest): Promise<unknown> {
  const params = req.params ?? [];
  switch (req.method) {
    case 'eth_chainId':
    case 'net_version':
      return req.method === 'net_version' ? String(config.EVM_CHAIN_ID) : CHAIN_ID_HEX;

    case 'web3_clientVersion':
      return 'HyPaper/1.0 (chain emulator)';

    case 'eth_blockNumber':
      return '0x' + (await h.readCurrentBlock()).toString(16);

    case 'eth_getBalance':
      // params: [address, blockTag]. We ignore both — every account
      // has fake huge balance in paper mode.
      return FAKE_BALANCE_WEI_HEX;

    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return ZERO_HEX;

    case 'eth_estimateGas':
      return FAKE_GAS_LIMIT_HEX;

    case 'eth_getTransactionCount':
      // Always 0 — no nonce tracking in the emulator. Wallets compute
      // their own nonces; we accept whatever they sign.
      return ZERO_HEX;

    case 'eth_getCode': {
      // Pretend the contract has bytecode (anything non-empty) so
      // wallets recognise it as a contract address.
      const [addr] = params as [string];
      if (addr?.toLowerCase() === h.CONTRACT_ADDR) return '0x60806040'; // arbitrary
      return '0x';
    }

    case 'eth_call':
      return handleEthCall(params);

    case 'eth_sendRawTransaction':
      return handleSendRawTransaction(params);

    case 'eth_getTransactionReceipt':
      return handleGetReceipt(params);

    case 'eth_getLogs':
      return handleGetLogs(params);

    case 'eth_getBlockByNumber':
      return handleGetBlock(params);

    case 'eth_feeHistory':
      // Some wallets call this. Return a minimal empty-ish history.
      return { oldestBlock: ZERO_HEX, baseFeePerGas: [ZERO_HEX], gasUsedRatio: [0] };

    case 'eth_syncing':
      return false;

    case 'eth_fillTransaction': {
      // Geth/parity-style helper some wallets call to populate
      // missing fields before signing. Return the input merged with
      // emulator defaults so the wallet has gasPrice/nonce/etc to
      // work with. Not a write — no state changes here.
      const [tx] = (params as [Record<string, unknown> | undefined]) ?? [];
      return {
        raw: '0x',
        tx: {
          ...(tx ?? {}),
          chainId: CHAIN_ID_HEX,
          gas: FAKE_GAS_LIMIT_HEX,
          gasPrice: ZERO_HEX,
          nonce: ZERO_HEX,
        },
      };
    }

    default:
      throw rpcError(-32601, `method not supported: ${req.method}`);
  }
}

// ── Per-method handlers ───────────────────────────────────────────

async function handleEthCall(params: unknown[]): Promise<string> {
  const [callObj] = params as [{ to?: string; data?: string }];
  if (!callObj?.to || !callObj?.data) throw rpcError(-32602, 'eth_call requires to + data');
  if (callObj.to.toLowerCase() !== h.CONTRACT_ADDR) {
    throw rpcError(-32602, `unknown contract address: ${callObj.to}`);
  }
  const { name, args } = decodeCall(callObj.data);
  switch (name) {
    case 'currentSnapshotOf': return h.currentSnapshotOf({ user: args[0], market: args[1] });
    case 'tokenURI':          return h.tokenURI({ tokenId: args[0] });
    case 'ownerOf':           return h.ownerOf({ tokenId: args[0] });
    case 'marketOf':          return h.marketOf({ tokenId: args[0] });
    case 'balanceOf':         return h.balanceOf({ user: args[0] });
    case 'name':              return h.name();
    case 'symbol':            return h.symbol();
    case 'supportsInterface': return h.supportsInterface({ interfaceId: args[0] });
    default:
      throw rpcError(-32601, `view fn not supported in emulator: ${name}`);
  }
}

async function handleSendRawTransaction(params: unknown[]): Promise<string> {
  const [rawTx] = params as [string];
  if (!rawTx?.startsWith('0x')) throw rpcError(-32602, 'eth_sendRawTransaction requires raw 0x… bytes');
  const tx = parseSignedTx(rawTx);
  if (tx.to !== h.CONTRACT_ADDR) {
    throw rpcError(-32602, `tx target mismatch: ${tx.to} vs ${h.CONTRACT_ADDR}`);
  }
  const { name, args } = decodeCall(tx.data);
  const txHash = h.syntheticTxHash(rawTx);
  switch (name) {
    case 'publish': {
      const r = await h.publish(tx.from, { market: args[0], uri: args[1] }, txHash);
      receiptCache.set(txHash, { blockNumber: r.blockNumber, from: tx.from, to: h.CONTRACT_ADDR, status: 1 });
      return txHash;
    }
    case 'deleteForMarket': {
      const r = await h.deleteForMarket(tx.from, { market: args[0] }, txHash);
      receiptCache.set(txHash, { blockNumber: r.blockNumber, from: tx.from, to: h.CONTRACT_ADDR, status: 1 });
      return txHash;
    }
    case 'burn': {
      const r = await h.burn(tx.from, { tokenId: args[0] }, txHash);
      receiptCache.set(txHash, { blockNumber: r.blockNumber, from: tx.from, to: h.CONTRACT_ADDR, status: 1 });
      return txHash;
    }
    default:
      throw rpcError(-32601, `state fn not supported in emulator: ${name}`);
  }
}

// In-memory cache so eth_getTransactionReceipt right after
// eth_sendRawTransaction returns the matching block. Receipts
// expire when the cache grows past 1k entries (LRU-ish via insertion
// order — Map iteration order is insertion order in JS).
const receiptCache = new Map<string, { blockNumber: number; from: string; to: string; status: 0 | 1 }>();
function trimReceiptCache(): void {
  if (receiptCache.size > 1000) {
    const oldestKey = receiptCache.keys().next().value;
    if (oldestKey) receiptCache.delete(oldestKey);
  }
}

async function handleGetReceipt(params: unknown[]): Promise<unknown> {
  const [txHash] = params as [string];
  const cached = receiptCache.get(txHash);
  if (!cached) return null; // not found is the standard "not yet mined" response
  trimReceiptCache();
  // Pull this tx's logs from chain_events to populate the receipt.
  const logRows = await db.select().from(chainEvents)
    .where(eq(chainEvents.txHash, txHash))
    .orderBy(chainEvents.logIndex);
  const blockHex = '0x' + cached.blockNumber.toString(16);
  return {
    transactionHash: txHash,
    transactionIndex: '0x0',
    blockHash: blockHex.padStart(66, '0').replace('0x', '0x' + '0'.repeat(64 - cached.blockNumber.toString(16).length)),
    blockNumber: blockHex,
    from: cached.from,
    to: cached.to,
    cumulativeGasUsed: '0x0',
    gasUsed: '0x0',
    contractAddress: null,
    logs: logRows.map((l, idx) => ({
      address: l.address,
      topics: [l.topic0, l.topic1, l.topic2, l.topic3].filter((t): t is string => t !== null),
      data: l.data,
      blockNumber: blockHex,
      transactionHash: txHash,
      transactionIndex: '0x0',
      blockHash: blockHex,
      logIndex: '0x' + idx.toString(16),
      removed: false,
    })),
    logsBloom: '0x' + '0'.repeat(512),
    status: cached.status === 1 ? '0x1' : '0x0',
    type: '0x2',
    effectiveGasPrice: '0x0',
  };
}

async function handleGetLogs(params: unknown[]): Promise<unknown[]> {
  const [filter] = params as [{
    fromBlock?: string;
    toBlock?: string;
    address?: string | string[];
    topics?: (string | string[] | null)[];
  }];
  const fromBlock = filter?.fromBlock ? parseInt(filter.fromBlock, 16) : 0;
  const toBlock = filter?.toBlock && filter.toBlock !== 'latest'
    ? parseInt(filter.toBlock, 16)
    : await h.readCurrentBlock();

  const conditions = [
    gte(chainEvents.blockNumber, fromBlock),
    lte(chainEvents.blockNumber, toBlock),
  ];
  // Address filter — accept string or array; fold to lowercase set.
  if (filter?.address) {
    const addrs = (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) => a.toLowerCase());
    conditions.push(inArray(chainEvents.address, addrs));
  }
  // Topic 0 filter — viem typically passes [topic0] or [[t1, t2]].
  const topic0 = filter?.topics?.[0];
  if (typeof topic0 === 'string') {
    conditions.push(eq(chainEvents.topic0, topic0));
  } else if (Array.isArray(topic0) && topic0.length > 0) {
    conditions.push(inArray(chainEvents.topic0, topic0));
  }

  const rows = await db.select().from(chainEvents)
    .where(and(...conditions))
    .orderBy(chainEvents.blockNumber, chainEvents.logIndex);

  return rows.map((l) => ({
    address: l.address,
    topics: [l.topic0, l.topic1, l.topic2, l.topic3].filter((t): t is string => t !== null),
    data: l.data,
    blockNumber: '0x' + l.blockNumber.toString(16),
    transactionHash: l.txHash,
    transactionIndex: '0x0',
    blockHash: '0x' + l.blockNumber.toString(16).padStart(64, '0'),
    logIndex: '0x' + l.logIndex.toString(16),
    removed: false,
  }));
}

async function handleGetBlock(params: unknown[]): Promise<unknown> {
  const [blockTag] = params as [string];
  const blockNum = blockTag === 'latest' || blockTag === 'pending' || blockTag === 'safe' || blockTag === 'finalized'
    ? await h.readCurrentBlock()
    : parseInt(blockTag, 16);
  const blockHex = '0x' + blockNum.toString(16);
  return {
    number: blockHex,
    hash: '0x' + blockNum.toString(16).padStart(64, '0'),
    parentHash: '0x' + Math.max(0, blockNum - 1).toString(16).padStart(64, '0'),
    timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
    transactions: [],
    gasLimit: '0x' + (30_000_000).toString(16),
    gasUsed: '0x0',
    miner: '0x' + '0'.repeat(40),
  };
}

function rpcError(code: number, message: string): Error {
  const e = new Error(message) as Error & { code: number };
  e.code = code;
  return e;
}

// sql import retained for future expansions; suppress unused-import noise.
void sql;
