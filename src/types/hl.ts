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
  oid: number;
  order: HlOrderWire;
}

// === Exchange action types ===

export interface HlOrderAction {
  type: 'order';
  orders: HlOrderWire[];
  grouping: 'na' | 'normalTpsl' | 'positionTpsl';
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
  oid: number;
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

/** TWAP order — split into ~30s suborders, max 3% slippage per slice. */
export interface HlTwapWire {
  a: number;       // asset
  b: boolean;      // isBuy
  s: string;       // total size
  r: boolean;      // reduceOnly
  m: number;       // duration in minutes
  t: boolean;      // randomize toggle
}

export interface HlTwapOrderAction {
  type: 'twapOrder';
  twap: HlTwapWire;
}

/** Cancel an in-flight TWAP. We surface this for completeness even though
 *  HyPaper's TWAP impl is approximate. */
export interface HlTwapCancelAction {
  type: 'twapCancel';
  a: number;       // asset
  t: number;       // twapId
}

export type HlExchangeAction =
  | HlOrderAction
  | HlCancelAction
  | HlCancelByCloidAction
  | HlModifyAction
  | HlBatchModifyAction
  | HlUpdateLeverageAction
  | HlTwapOrderAction
  | HlTwapCancelAction;

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
