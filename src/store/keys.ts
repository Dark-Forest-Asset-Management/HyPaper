export const KEYS = {
  // Market data
  MARKET_MIDS: 'market:mids',
  MARKET_CTX: (coin: string) => `market:ctx:${coin}`,
  MARKET_L2: (coin: string) => `market:l2:${coin}`,
  MARKET_META: 'market:meta',
  // Sub-DEX universe metadata. Main DEX uses MARKET_META; each
  // builder-deployed perp DEX (xyz, flx, vntl, …) gets its own meta
  // cache. PERPDEXS holds the JSON list returned by /info perpDexs —
  // used to decode HL's asset id encoding back to a coin name.
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

  // Orders
  ORDER: (oid: number) => `order:${oid}`,
  ORDERS_OPEN: 'orders:open',
  ORDERS_TRIGGERS: 'orders:triggers',
  /** Bracket OCO links: a Set keyed by parent oid containing its sibling
   *  oids (TP/SL group). When one fills or cancels, the matcher walks
   *  this set and cancels the others, mirroring HL's `normalTpsl` /
   *  `positionTpsl` grouping. */
  ORDER_BRACKET: (oid: number) => `order:${oid}:bracket`,
  /** Sorted set of `expiresAfter` deadlines: score = expiry-ms,
   *  member = oid. The matcher sweeps low-scored entries to cancel. */
  ORDERS_EXPIRY: 'orders:expiry',
  /** Highest nonce seen per wallet. Replay protection. */
  USER_NONCE_MAX: (userId: string) => `user:${userId}:nonce:max`,

  // TWAP — split into ~30s suborders, max 3% slippage per slice.
  TWAP: (twapId: number) => `twap:${twapId}`,
  TWAPS_ACTIVE: 'twaps:active',
  USER_TWAPS: (userId: string) => `user:${userId}:twaps`,

  // Active users (for funding)
  USERS_ACTIVE: 'users:active',

  // Sequences
  SEQ_OID: 'seq:oid',
  SEQ_TID: 'seq:tid',
  SEQ_TWAP_ID: 'seq:twapId',
} as const;
