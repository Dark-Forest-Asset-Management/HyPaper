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
  // Spot universe (tokens + pairs) from /info spotMeta. Used to decode HL's
  // spot asset id encoding (10_000 + spotPairIndex) back to a pair name +
  // base-token szDecimals.
  MARKET_SPOT_META: 'market:spotmeta',

  // User account
  USER_ACCOUNT: (userId: string) => `user:${userId}:account`,
  USER_POSITIONS: (userId: string) => `user:${userId}:positions`,
  USER_POS: (userId: string, asset: number) => `user:${userId}:pos:${asset}`,
  USER_LEV: (userId: string, asset: number) => `user:${userId}:lev:${asset}`,
  USER_ORDERS: (userId: string) => `user:${userId}:orders`,

  // ── Per-dex (HIP-3 sub-dex) scoping ───────────────────────────────────
  // Each builder-deployed perp DEX (xyz, flx, vntl, …) is its own
  // sub-account on HL. Balance, positions set, and orders set are scoped
  // per dex. USER_POS/USER_LEV stay asset-keyed since the asset id itself
  // already encodes (dex, localIdx) for asset >= 100_000.
  //
  //   scope === ''   → native dex, uses the unscoped keys above (back-compat).
  //   scope === 'xyz' → uses these scoped keys.
  //
  // The scoped variants are NEVER used for scope==='' so the native account's
  // existing on-disk layout is unchanged.
  USER_BAL_FIELD: (scope: string) => scope ? `balance:${scope}` : 'balance',
  USER_POSITIONS_SCOPED: (userId: string, scope: string) =>
    scope ? `user:${userId}:positions:${scope}` : `user:${userId}:positions`,
  USER_ORDERS_SCOPED: (userId: string, scope: string) =>
    scope ? `user:${userId}:orders:${scope}` : `user:${userId}:orders`,
  USER_CLOIDS: (userId: string) => `user:${userId}:cloids`,
  USER_FILLS: (userId: string) => `user:${userId}:fills`,
  USER_FUNDINGS: (userId: string) => `user:${userId}:fundings`,
  // Account-value/PnL snapshot history for /info portfolio. Sorted set:
  // score = sample time (ms), member = `${time}:${accountValue}:${pnl}`.
  USER_AVHIST: (userId: string) => `user:${userId}:avhist`,

  // Orders
  ORDER: (oid: number) => `order:${oid}`,
  ORDERS_OPEN: 'orders:open',
  ORDERS_TRIGGERS: 'orders:triggers',
  /** OCO sibling links — populated ONLY on child orders (TP/SL legs). Set
   *  contains the other child oids in the bracket. Used when a child
   *  fills: walk this set and cancel the siblings so they don't fire on
   *  the same position twice. NOT populated on parent orders, because a
   *  parent fill must leave its children alive (they're the bracketed
   *  exits on the new position). */
  ORDER_BRACKET: (oid: number) => `order:${oid}:bracket`,
  /** Parent → children link — populated ONLY on the parent (entry) order.
   *  Used when the parent is CANCELLED (not filled): walk the children
   *  and cancel them too, since a bracket without an entry is meaningless. */
  ORDER_CHILDREN: (oid: number) => `order:${oid}:children`,
  /** Reverse pointer from child → parent. Stored as a single oid string. */
  ORDER_PARENT: (oid: number) => `order:${oid}:parent`,
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
  SEQ_TWAP: 'seq:twapId',
} as const;
