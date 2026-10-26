/**
 * A paper sub-account transfer is a FLOW, not PnL: both sides get a signed
 * ledger row so the portfolio's net deposits move with the balance. Before
 * this, the master's PnL fell by the transfer and the sub's rose by it,
 * which HL's own portfolio never does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();
vi.mock('../store/redis.js', () => ({ redis: redisMock }));
vi.mock('../api/middleware/auth.js', () => ({ ensureAccount: vi.fn() }));
const recordLedgerUpdate = vi.fn();
vi.mock('../store/pg-sink.js', () => ({
  upsertUser: vi.fn(), updateUserBalance: vi.fn(), recordLedgerUpdate, recordFunding: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { subAccountTransfer } = await import('../engine/subaccount.js');

const MASTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SUB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('subAccountTransfer ledger rows', () => {
  beforeEach(async () => {
    redisMock.flushall();
    recordLedgerUpdate.mockClear();
    await redisMock.set(KEYS.SUBACCOUNT_MASTER(SUB), MASTER);
    await redisMock.hset(KEYS.USER_ACCOUNT(MASTER), 'balance', '100.000000');
    await redisMock.hset(KEYS.USER_ACCOUNT(SUB), 'balance', '0.000000');
  });

  it('master → sub: balances move and both sides get a signed subAccountTransfer row', async () => {
    const r = await subAccountTransfer(MASTER, SUB, true, 25_000_000);
    expect(r).toEqual({ ok: true });
    expect((await redisMock.hgetall(KEYS.USER_ACCOUNT(MASTER))).balance).toBe('75.000000');
    expect((await redisMock.hgetall(KEYS.USER_ACCOUNT(SUB))).balance).toBe('25.000000');
    expect(recordLedgerUpdate).toHaveBeenCalledTimes(2);
    const [[senderId, senderRow], [receiverId, receiverRow]] = recordLedgerUpdate.mock.calls;
    expect(senderId).toBe(MASTER);
    expect(senderRow).toMatchObject({ deltaType: 'subAccountTransfer', usdc: '-25.000000' });
    expect(receiverId).toBe(SUB);
    expect(receiverRow).toMatchObject({ deltaType: 'subAccountTransfer', usdc: '25.000000' });
    // HL's unsigned element for the ledger endpoint, on both rows.
    for (const row of [senderRow, receiverRow]) {
      expect(row.delta).toEqual({ type: 'subAccountTransfer', usdc: '25.000000', user: MASTER, destination: SUB });
    }
    // Net deposits move by exactly the balance change, so accountValue − netDeposits is unchanged for both.
    expect(Number(senderRow.usdc)).toBe(75 - 100);
    expect(Number(receiverRow.usdc)).toBe(25 - 0);
  });

  it('sub → master: signs flip', async () => {
    await redisMock.hset(KEYS.USER_ACCOUNT(SUB), 'balance', '40.000000');
    await subAccountTransfer(MASTER, SUB, false, 10_000_000);
    const [[senderId, senderRow], [receiverId, receiverRow]] = recordLedgerUpdate.mock.calls;
    expect(senderId).toBe(SUB);
    expect(senderRow.usdc).toBe('-10.000000');
    expect(receiverId).toBe(MASTER);
    expect(receiverRow.usdc).toBe('10.000000');
  });

  it('writes nothing when the sender cannot cover the amount', async () => {
    const r = await subAccountTransfer(MASTER, SUB, true, 500_000_000);
    expect(r).toMatchObject({ error: expect.stringContaining('Insufficient') });
    expect(recordLedgerUpdate).not.toHaveBeenCalled();
  });
});
