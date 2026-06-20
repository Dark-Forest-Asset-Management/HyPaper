/**
 * Liquidation engine types.
 *
 * These mirror the shape HyPaper uses internally for liquidation events,
 * vault accounting, and per-position liquidation status. No HL prod
 * equivalent exists (HL doesn't expose its internal liquidation log as a
 * user-readable endpoint) so shapes are HyPaper-native.
 */

// ── Liquidation event (one row in the DB per liquidation) ─────────────────

export interface LiquidationEvent {
  /** Internal auto-increment id (set by DB on insert). */
  id?: number;
  /** The user whose position was liquidated. */
  userId: string;
  /** Asset index (integer, same encoding as orders/fills). */
  asset: number;
  /** Coin name e.g. "BTC", "XRP". */
  coin: string;
  /** Position size at the moment of liquidation (signed — negative = short). */
  szi: string;
  /** Mark price that triggered the liquidation. */
  markPx: string;
  /** Entry price of the liquidated position. */
  entryPx: string;
  /** Leverage at the time of liquidation. */
  leverage: number;
  /** 'cross' or 'isolated'. */
  marginType: 'cross' | 'isolated';
  /**
   * How much USDC was recovered from the close and returned to the user's
   * balance. For a full liquidation this is 0 or a small residual; for a
   * partial (20 % slice) it is the proceeds of that slice.
   */
  amountRecovered: string;
  /** Maintenance margin that was consumed / forfeited. */
  marginLost: string;
  /** 'full' or 'partial' (the 20 % first-slice of a >$100 k position). */
  liquidationType: 'full' | 'partial';
  /** Unix ms timestamp of the liquidation. */
  time: number;
  /** Unique hash for this event (mirrors fill/funding hash pattern). */
  hash: string;
}

// ── Per-position maintenance margin result ────────────────────────────────

export interface MaintenanceMarginResult {
  /** Required maintenance margin in USDC. */
  maintenanceMargin: string;
  /** The rate used (e.g. "0.0125" for 1.25 %). */
  maintenanceMarginRate: string;
  /** Position notional (|szi| × markPx). */
  positionNotional: string;
}

// ── Liquidation check result (returned from the checker per position) ──────

export interface LiquidationCheckResult {
  /** True when the position should be liquidated right now. */
  shouldLiquidate: boolean;
  /** Current account equity at the time of check. */
  accountEquity: string;
  /** Required maintenance margin. */
  maintenanceMargin: string;
  /** Shortfall amount (maintenanceMargin − accountEquity, 0 when safe). */
  shortfall: string;
}

// ── Liquidator vault state ────────────────────────────────────────────────

export interface LiquidatorVaultState {
  /** Total USDC proceeds collected by the vault across all liquidations. */
  totalCollected: string;
  /** Wallet address of the vault (from LIQUIDATOR_VAULT_ADDRESS env var). */
  vaultAddress: string;
  /** Unix ms timestamp of the last vault update. */
  lastUpdated: number;
}
