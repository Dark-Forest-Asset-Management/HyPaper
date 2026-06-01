import { getUserFillsPg, getUserFillsByTimePg } from '../store/pg-queries.js';
import type { PaperFill } from '../types/order.js';

/** Filter fills by dex scope. scope==='' → native rows (coin has no colon).
 *  scope==='xyz' → coin starts with 'xyz:'. Same convention as historicalOrders
 *  filtering in info.ts. Engine-layer post-filter is fine for paper-account
 *  volumes; production SQL would push this into the WHERE clause. */
function scopeFilterFills(rows: PaperFill[], scope: string): PaperFill[] {
  if (!scope) return rows.filter((r) => !r.coin.includes(':'));
  const prefix = `${scope}:`;
  return rows.filter((r) => r.coin.startsWith(prefix));
}

export async function getUserFills(userId: string, limit = 100, scope = ''): Promise<PaperFill[]> {
  // Over-fetch when filtering so we still return up to `limit` matching rows
  // after the post-filter drops the other-scope rows.
  const rows = await getUserFillsPg(userId, scope ? Math.max(limit * 4, 200) : limit);
  return scopeFilterFills(rows, scope).slice(0, limit);
}

export async function getUserFillsByTime(
  userId: string,
  startTime: number,
  endTime?: number,
  scope = '',
): Promise<PaperFill[]> {
  const rows = await getUserFillsByTimePg(userId, startTime, endTime);
  return scopeFilterFills(rows, scope);
}
