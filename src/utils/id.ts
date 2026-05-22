import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';

export async function nextOid(): Promise<number> {
  return redis.incr(KEYS.SEQ_OID);
}

export async function nextTid(): Promise<number> {
  return redis.incr(KEYS.SEQ_TID);
}

export async function nextTwapId(): Promise<number> {
  return redis.incr(KEYS.SEQ_TWAP);
}
