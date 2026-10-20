import { getUserFillsPg, getUserFillsByTimePg } from '../store/pg-queries.js';
import type { PaperFill } from '../types/order.js';

// Fills are NOT filtered by dex. Public HL's userFills / userFillsByTime
// return every dex's fills for the user and ignore a `dex` param entirely —
// probed 2026-10-20 for 0x0aafd0eddbffd00ccea26e90436d50a4f8c22839: no dex,
// dex "xyz", dex "flx" and dex "" all returned the same 2000 rows, every one
// an `xyz:` coin. HyPaper used to return native rows only when no dex was
// passed — which is what slushy sends — so HIP-3 fills never reached Trade
// History.

/** HL returns at most the 2000 most recent fills (same probe: 2000 rows). */
export const HL_USER_FILLS_LIMIT = 2000;

export async function getUserFills(userId: string, limit = HL_USER_FILLS_LIMIT): Promise<PaperFill[]> {
  return getUserFillsPg(userId, limit);
}

export async function getUserFillsByTime(
  userId: string,
  startTime: number,
  endTime?: number,
): Promise<PaperFill[]> {
  return getUserFillsByTimePg(userId, startTime, endTime);
}
