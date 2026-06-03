export const KEYS = {
  // Market data
  MARKET_MIDS: 'market:mids',
  MARKET_CTX: (coin: string) => `market:ctx:${coin}`,
  MARKET_L2: (coin: string) => `market:l2:${coin}`,
  MARKET_META: 'market:meta',
  MARKET_PERPDEXS: 'market:perpdexs',
  MARKET_META_DEX: (dex: string) => `market:meta:${dex}`,

  // User account
  USER_ACCOUNT: (userId: string) => `user:${userId}:account`,
  USER_POSITIONS: (userId: string) => `user:${userId}:positions`,
  USER_POS: (userId: string, asset: number) => `user:${userId}:pos:${asset}`,
  USER_LEV: (userId: string, asset: number) => `user:${userId}:lev:${asset}`,
  USER_ORDERS: (userId: string) => `user:${userId}:orders`,
  USER_CLOIDS: (userId: string) => `user:${userId}:cloids`,
  USER_FILLS: (userId: string) => `user:${userId}:fills`,
  USER_FUNDINGS: (userId: string) => `user:${userId}:fundings`,

  // Spot balances (Task 2)
  USER_SPOT_BALANCES: (userId: string) => `user:${userId}:spot_balances`,

  // Orders
  ORDER: (oid: number) => `order:${oid}`,
  ORDERS_OPEN: 'orders:open',
  ORDERS_TRIGGERS: 'orders:triggers',
  ORDER_BRACKET: (oid: number) => `order:${oid}:bracket`,
  ORDER_CHILDREN: (oid: number) => `order:${oid}:children`,
  ORDER_PARENT: (oid: number) => `order:${oid}:parent`,
  ORDERS_EXPIRY: 'orders:expiry',
  USER_NONCE_MAX: (userId: string) => `user:${userId}:nonce:max`,

  // Active users (for funding)
  USERS_ACTIVE: 'users:active',

  // Sequences
  SEQ_OID: 'seq:oid',
  SEQ_TID: 'seq:tid',

  // TWAP orders
  TWAP: (twapId: number) => `twap:${twapId}`,
  TWAPS_ACTIVE: 'twaps:active',
  SEQ_TWAP: 'seq:twapId',
  USER_TWAPS: (userId: string) => `user:${userId}:twaps`,

  // ── Sub-accounts (Task 1) ────────────────────────────────────────────────────
  USER_SUBACCOUNTS: (masterUserId: string) => `user:${masterUserId}:subaccounts`,
  SUBACCOUNT_META: (subAddr: string) => `subaccount:${subAddr}:meta`,
  SUBACCOUNT_MASTER: (subAddr: string) => `subaccount:${subAddr}:master`,

  // ── Vaults (Task 1) ──────────────────────────────────────────────────────────
  USER_VAULT_EQUITIES: (userId: string) => `user:${userId}:vault_equities`,
  VAULT_META: (vaultAddress: string) => `vault:${vaultAddress}:meta`,

  // ── API Wallets / Agents (Task 3) ────────────────────────────────────────────
  USER_AGENTS: (userId: string) => `user:${userId}:agents`,

  // ── Builder Fees (Task 3) ────────────────────────────────────────────────────
  USER_BUILDER_FEES: (userId: string) => `user:${userId}:builder_fees`,

  // ── Referrals (Task 3) ───────────────────────────────────────────────────────
  USER_REFERRER: (userId: string) => `user:${userId}:referrer`,

  // ── Staking / Delegation (Task 4) ────────────────────────────────────────────
  //
  // HYPE staking balance available in the staking account (not yet delegated).
  // Stored as wei string (1 HYPE = 1e8 wei = 100000000).
  USER_STAKING_BALANCE: (userId: string) => `user:${userId}:staking_balance`,
  //
  // Active delegations — sorted set:
  //   score  = lockedUntil (unix ms, 1-day lockup after delegation)
  //   member = JSON { validator, wei, lockedUntil, delegatedAt }
  USER_DELEGATIONS: (userId: string) => `user:${userId}:delegations`,
  //
  // 7-day unstake queue — sorted set:
  //   score  = unlockTime (unix ms, 7 days after cWithdraw)
  //   member = JSON { wei, unlockTime, queuedAt }
  // The StakingWorker sweeps this every 60s and completes withdrawals.
  USER_STAKING_QUEUE: (userId: string) => `user:${userId}:staking_queue`,
  //
  // Staking event log — Redis list (lpush, newest first):
  //   each entry = JSON { type, wei, validator?, timestamp, unlockTime? }
  // Capped at 200 entries per user. Used by /info delegatorHistory.
  STAKING_EVENTS: (userId: string) => `user:${userId}:staking_events`,
} as const;