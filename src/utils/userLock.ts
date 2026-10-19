import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-user critical section for everything that reads-then-writes a user's
 * positions / balance (matcher fills, liquidations, isolated-margin changes).
 *
 * Without it, two writers interleave on the same position: the matcher reads
 * szi/entryPx, the liquidation worker closes the position, and the matcher
 * then writes a position computed from the stale read (resurrecting it or
 * double-counting PnL). Each call queues behind the previous holder for that
 * user; different users never wait on each other.
 *
 * Reentrant: code already holding a user's lock (e.g. a fill that reconciles
 * trailing stops which fire another fill) runs straight through instead of
 * deadlocking on itself.
 *
 * In-process: HyPaper runs as a single Node process (hypaper.service). A
 * second process writing the same Redis would need a Redis lock instead.
 */
const tails = new Map<string, Promise<void>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();

export async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const holding = held.getStore();
  if (holding?.has(userId)) return fn();

  const prev = tails.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const tail = prev.then(() => mine);
  tails.set(userId, tail);

  await prev;
  try {
    return await held.run(new Set([...(holding ?? []), userId]), fn);
  } finally {
    release();
    if (tails.get(userId) === tail) tails.delete(userId);
  }
}
