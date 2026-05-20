/**
 * EVM coder — wraps ethers.Interface for ABI encode/decode plus
 * helpers for parsing signed raw transactions and computing event
 * topic hashes.
 *
 * The dispatcher uses these to:
 *   - Decode `eth_call` calldata → function name + args
 *   - Encode the return value of a view fn back into ABI bytes
 *   - Decode a raw signed tx → recover signer + extract function args
 *   - Encode event data + compute topic hashes when emitting logs
 */

import { ethers } from 'ethers';
import { SLUSHY_CHART_SNAPSHOTS_ABI } from './abi.js';

// One Interface instance for the whole contract. ethers caches selector
// lookups so this is cheap to reuse.
export const IFACE = new ethers.Interface(SLUSHY_CHART_SNAPSHOTS_ABI);

/** Decode the function selector (first 4 bytes) of calldata + parse
 *  args. Throws if the selector doesn't match any known function. */
export function decodeCall(calldata: string): { name: string; args: ethers.Result } {
  const selector = calldata.slice(0, 10); // 0x + 4 bytes hex
  const fragment = IFACE.getFunction(selector);
  if (!fragment) throw new Error(`unknown function selector: ${selector}`);
  const args = IFACE.decodeFunctionData(fragment, calldata);
  return { name: fragment.name, args };
}

/** ABI-encode a function's return value back to hex. Used for
 *  eth_call responses. */
export function encodeResult(fnName: string, values: unknown[]): string {
  return IFACE.encodeFunctionResult(fnName, values);
}

/** Decode a raw signed tx (0x-prefixed hex of the RLP-encoded signed
 *  bytes) and recover the sender. Returns the parsed tx object plus
 *  the recovered `from` address (lowercased). */
export function parseSignedTx(rawHex: string): {
  from: string;
  to: string | null;
  data: string;
  value: bigint;
  gas: bigint;
  nonce: number;
  hash: string;
} {
  const tx = ethers.Transaction.from(rawHex);
  if (!tx.from) throw new Error('tx has no recoverable signer');
  return {
    from: tx.from.toLowerCase(),
    to: tx.to?.toLowerCase() ?? null,
    data: tx.data,
    value: tx.value,
    gas: tx.gasLimit,
    nonce: tx.nonce,
    hash: tx.hash ?? ethers.keccak256(tx.serialized),
  };
}

/** Pre-computed event topic hashes (keccak256 of the event signature).
 *  Used when writing chain_events rows so eth_getLogs can topic-filter. */
export const EVENT_TOPICS = {
  SnapshotPublished: IFACE.getEvent('SnapshotPublished')!.topicHash,
  SnapshotBurned:    IFACE.getEvent('SnapshotBurned')!.topicHash,
  Transfer:          IFACE.getEvent('Transfer')!.topicHash,
};

/** Encode an event's non-indexed args + return the topics array
 *  (topic0 = event hash, topic1..N = indexed args ABI-encoded as
 *  bytes32). The dispatcher writes these into chain_events. */
export function encodeEvent(eventName: keyof typeof EVENT_TOPICS, args: Record<string, unknown>): {
  topics: string[];
  data: string;
} {
  const fragment = IFACE.getEvent(eventName);
  if (!fragment) throw new Error(`unknown event: ${eventName}`);
  // ethers' encodeEventLog wants positional args in the order they
  // appear in the event definition. Build the array by walking inputs.
  const ordered = fragment.inputs.map((i) => args[i.name]);
  const log = IFACE.encodeEventLog(fragment, ordered);
  return { topics: log.topics, data: log.data };
}

/** keccak256 of a UTF-8 string — used for the marketHash indexed
 *  topic in SnapshotPublished/Burned. */
export function keccakString(s: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}
