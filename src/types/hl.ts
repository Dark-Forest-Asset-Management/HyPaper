// HyperLiquid API types — mirrors the real HL API shapes

// === Exchange request types ===

export interface HlOrderWire {
  a: number;       // asset index
  b: boolean;      // isBuy
  p: string;       // price (string decimal)
  s: string;       // size (string decimal)
  r: boolean;      // reduceOnly
  t: HlOrderType;
  c?: string;      // cloid (client order ID)
}

export interface HlOrderType {
  limit: HlLimitOrder;
  trigger?: HlTriggerOrder;
}

export interface HlLimitOrder {
  tif: 'Gtc' | 'Ioc' | 'Alo';
}

export interface HlTriggerOrder {
  isMarket: boolean;
  triggerPx: string;
  tpsl: 'tp' | 'sl';
}

export interface HlCancelRequest {
  a: number;    // asset index
  o: number;    // oid
}

export interface HlCancelByCloidRequest {
  asset: number;
  cloid: string;
}

export interface HlModifyRequest {
  oid: number | string;   // numeric OID or cloid string
  order: HlOrderWire;
}

// === Exchange action types ===

export interface HlOrderAction {
  type: 'order';
  orders: HlOrderWire[];
  grouping: 'na' | 'normalTpsl' | 'positionTpsl';
  builder?: { b: string; f: number };   // optional builder fee sub-object
}

export interface HlCancelAction {
  type: 'cancel';
  cancels: HlCancelRequest[];
}

export interface HlCancelByCloidAction {
  type: 'cancelByCloid';
  cancels: HlCancelByCloidRequest[];
}

export interface HlModifyAction {
  type: 'modify';
  oid: number | string;   // numeric OID or cloid string (HL spec: Number | Cloid)
  order: HlOrderWire;
}

export interface HlBatchModifyAction {
  type: 'batchModify';
  modifies: HlModifyRequest[];
}

export interface HlUpdateLeverageAction {
  type: 'updateLeverage';
  asset: number;
  isCross: boolean;
  leverage: number;
}

export interface HlTwapOrderAction {
  type: 'twapOrder';
  twap: {
    a: number;    // asset index
    b: boolean;   // isBuy
    s: string;    // total size
    r: boolean;   // reduceOnly
    m: number;    // minutes (minimum 5)
    t: boolean;   // randomize slice timing
  };
}

export interface HlTwapCancelAction {
  type: 'twapCancel';
  a: number;    // asset index
  t: number;    // twapId
}

// scheduleCancel — dead man's switch.
// When `time` is provided, all open orders will be cancelled at that unix-ms
// timestamp. Omitting `time` removes any previously scheduled cancel.
export interface HlScheduleCancelAction {
  type: 'scheduleCancel';
  time?: number;    // optional unix-ms timestamp (must be >= now + 5s)
}

// updateIsolatedMargin — add or remove margin from an isolated position.
// `ntli` is the amount in units of 1e-6 quote tokens (signed: + = add, - = remove).
export interface HlUpdateIsolatedMarginAction {
  type: 'updateIsolatedMargin';
  asset: number;
  isBuy: boolean;
  ntli: number;   // integer, 1e-6 units
}

// usdClassTransfer — transfer USDC between spot and perp balances.
// HyPaper acknowledges this with { type: 'default' } without moving funds
// (no spot balance is simulated).
export interface HlUsdClassTransferAction {
  type: 'usdClassTransfer';
  hyperliquidChain: 'Mainnet' | 'Testnet';
  signatureChainId: string;
  amount: string;
  toPerp: boolean;
  nonce: number;
}

// createSubAccount — HyPaper acknowledges but does not simulate sub-accounts.
export interface HlCreateSubAccountAction {
  type: 'createSubAccount';
  name: string;
}

// subAccountTransfer — transfer between master and sub-account.
export interface HlSubAccountTransferAction {
  type: 'subAccountTransfer';
  subAccountUser: string;
  isDeposit: boolean;
  usd: number;
}

// subAccountSpotTransfer — transfer spot assets to/from sub-account.
export interface HlSubAccountSpotTransferAction {
  type: 'subAccountSpotTransfer';
  subAccountUser: string;
  isDeposit: boolean;
  token: string;
  amount: string;
}

// vaultTransfer — deposit or withdraw from a vault.
export interface HlVaultTransferAction {
  type: 'vaultTransfer';
  vaultAddress: string;
  isDeposit: boolean;
  usd: number;
}

// === HlExchangeAction union ===
// All action types that the /exchange endpoint accepts.
// Adding a new action type here is all that's needed for TypeScript to
// allow the corresponding `case` block in exchange.ts.

export type HlExchangeAction =
  | HlOrderAction
  | HlCancelAction
  | HlCancelByCloidAction
  | HlModifyAction
  | HlBatchModifyAction
  | HlUpdateLeverageAction
  | HlTwapOrderAction
  | HlTwapCancelAction
  | HlScheduleCancelAction
  | HlUpdateIsolatedMarginAction
  | HlUsdClassTransferAction
  | HlCreateSubAccountAction
  | HlSubAccountTransferAction
  | HlSubAccountSpotTransferAction
  | HlVaultTransferAction;

// === Info request types ===

export interface HlInfoRequest {
  type: string;
  user?: string;
  oid?: number;
  coin?: string;
  startTime?: number;
  endTime?: number;
  req?: {
    coin: string;
    interval: string;
    startTime: number;
    endTime: number;
  };
}

// === Info response types ===

export interface HlMeta {
  universe: HlAssetInfo[];
}

export interface HlAssetInfo {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
}

export interface HlAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx?: string;
  impactPxs?: [string, string];
}

export interface HlMetaAndAssetCtxs {
  meta: HlMeta;
  assetCtxs: HlAssetCtx[];
}

// === Clearinghouse state (response shape) ===

export interface HlClearinghouseState {
  assetPositions: HlAssetPosition[];
  crossMarginSummary: HlMarginSummary;
  marginSummary: HlMarginSummary;
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  time: number;
}

export interface HlAssetPosition {
  position: HlPositionData;
  type: 'oneWay';
}

export interface HlPositionData {
  coin: string;
  szi: string;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  liquidationPx: string | null;
  leverage: HlLeverageData;
  cumFunding: HlCumFunding;
  maxLeverage: number;
  marginUsed: string;
}

export interface HlLeverageData {
  type: 'cross' | 'isolated';
  value: number;
  rawUsd?: string;
}

export interface HlCumFunding {
  allTime: string;
  sinceOpen: string;
  sinceChange: string;
}

export interface HlMarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

// === Order response types ===

export interface HlOpenOrder {
  coin: string;
  side: 'B' | 'A';
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  origSz: string;
  cloid?: string;
}

/** HL prod /info frontendOpenOrders — captured 2026-05-09 against a
 *  normalTpsl bracket on XRP. Every field below is present on every
 *  entry; explicit `null` for `tif` and `cloid` on triggers, prose
 *  string for `triggerCondition`, empty array for `children` (not
 *  optional). `triggerPx` is `'0.0'` for non-trigger orders, not omitted. */
export interface HlFrontendOpenOrder {
  coin: string;
  side: 'B' | 'A';
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  triggerCondition: string;
  isTrigger: boolean;
  triggerPx: string;
  children: HlTpSlChild[];
  isPositionTpsl: boolean;
  reduceOnly: boolean;
  orderType: string;
  origSz: string;
  tif: string | null;
  cloid: string | null;
}

export interface HlTpSlChild {
  oid: number;
  triggerPx: string;
  tpsl: 'tp' | 'sl';
}

// === Fill types ===

export interface HlUserFill {
  coin: string;
  px: string;
  sz: string;
  side: 'B' | 'A';
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  cloid?: string;
  feeToken: string;
  twapId: string | null;
  // Present only when this fill was the counterparty to a liquidation
  // (3 of 2000 fills in the captured HL prod sample). HyPaper has no
  // paper-liquidation simulation so it never emits this field, but
  // consumers should still know it can appear.
  liquidation?: {
    liquidatedUser: string;
    markPx: string;
    method: string;
  };
}

// === Order status response ===

export interface HlOrderStatus {
  status: 'order' | 'unknownOid';
  order?: HlFrontendOpenOrder & {
    status: string;
    statusTimestamp: number;
  };
}

// === Exchange response ===

export interface HlExchangeResponse {
  status: 'ok' | 'err';
  response?: {
    type: 'order' | 'cancel' | 'default';
    data?: {
      statuses: HlOrderResponseStatus[];
    };
  };
}

export type HlOrderResponseStatus =
  | { resting: { oid: number; cloid?: string } }
  | { filled: { totalSz: string; avgPx: string; oid: number; cloid?: string } }
  | { error: string }
  | 'success';

// === WebSocket message types ===

export interface HlWsMessage {
  channel: string;
  data: unknown;
}

export interface HlAllMids {
  mids: Record<string, string>;
}

export interface HlL2Book {
  coin: string;
  levels: [HlL2Level[], HlL2Level[]]; // [bids, asks]
  time: number;
}

export interface HlL2Level {
  px: string;
  sz: string;
  n: number;
}

export interface HlActiveAssetCtx {
  coin: string;
  ctx: HlAssetCtx;
}