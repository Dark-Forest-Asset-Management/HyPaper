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
  | HlVaultTransferAction
  | HlUsdSendAction
  | HlSpotSendAction           
  | HlSendAssetAction          
  | HlAgentSendAssetAction     
  | HlSendToEvmWithDataAction
  | HlApproveAgentAction
  | HlApproveBuilderFeeAction
  | HlSetReferrerAction
  | HlCDepositAction
  | HlCWithdrawAction
  | HlTokenDelegateAction; 

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
// ─────────────────────────────────────────────────────────────────────────────
// TASK 1 ADDITIONS — Sub-account & Vault info response types
// ─────────────────────────────────────────────────────────────────────────────

// === Sub-account info response types ===

/** Single entry in the /info subAccounts response array. */
export interface HlSubAccountInfo {
  name: string;
  subAccountUser: string;
  master: string;
  clearinghouseState: HlClearinghouseState;
  spotState: HlSubAccountSpotState;
}

export interface HlSubAccountSpotState {
  balances: HlSubAccountSpotBalance[];
}

export interface HlSubAccountSpotBalance {
  coin: string;
  token: number;
  total: string;
  hold: string;
  entryNtl: string;
}

// === Vault info response types ===

/** /info vaultDetails response shape. */
export interface HlVaultDetails {
  name: string;
  vaultAddress: string;
  leader: string;
  description: string;
  portfolio: unknown[];
  apr: number;
  followerState: HlVaultFollowerState | null;
  leaderFraction: number;
  leaderCommission: number;
  followers: HlVaultFollower[];
  maxDistributable: number;
  maxWithdrawable: number;
  isClosed: boolean;
  relationship: { type: string };
  allowDeposits: boolean;
  alwaysCloseOnWithdraw: boolean;
}

export interface HlVaultFollowerState {
  equity: string;
  pnl: string;
  allTimePnl: string;
}

export interface HlVaultFollower {
  user: string;
  vaultEquity: string;
  pnl: string;
  allTimePnl: string;
  daysFollowing: number;
  vaultEntryTime: number;
  lockupUntil: number;
}

/** Single entry in the /info userVaultEquities response array. */
export interface HlUserVaultEquity {
  vaultAddress: string;
  equity: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transfer action types
// All shapes confirmed from testnet captures 18-27.
// ─────────────────────────────────────────────────────────────────────────────

// usdClassTransfer — spot ↔ perp USDC transfer
// Signing: Pattern B (user-signed, HyperliquidTransaction:UsdClassTransfer)
// Action body includes hyperliquidChain + signatureChainId (required by HL server)
// Confirmed: disabled on unified accounts → "Action disabled when unified account is active"
export interface HlUsdClassTransferAction {
  type:              'usdClassTransfer';
  hyperliquidChain:  'Mainnet' | 'Testnet';
  signatureChainId:  string;   // "0x3e6" testnet, "0x66eee" mainnet
  amount:            string;
  toPerp:            boolean;
  nonce:             number;
}

// usdSend — send USDC from perp balance to another wallet
// Signing: Pattern B (HyperliquidTransaction:UsdSend)
// `time` == outer nonce (both must match)
// Confirmed: disabled on unified accounts
export interface HlUsdSendAction {
  type:              'usdSend';
  hyperliquidChain:  'Mainnet' | 'Testnet';
  signatureChainId:  string;
  destination:       string;   // recipient wallet address
  amount:            string;
  time:              number;   // = outer nonce
}

// spotSend — send spot token to another wallet
// Signing: Pattern B (HyperliquidTransaction:SpotSend)
// token format: "NAME:0xTOKENID" (ID differs between mainnet and testnet)
// Confirmed: disabled on unified accounts
export interface HlSpotSendAction {
  type:              'spotSend';
  hyperliquidChain:  'Mainnet' | 'Testnet';
  signatureChainId:  string;
  destination:       string;
  token:             string;   // e.g. "PURR:0xc4bf3f870c0e9465323c0b6ed28096c2"
  amount:            string;
  time:              number;
}

// sendAsset — generalised cross-DEX / cross-user token transfer
// Signing: Pattern B (HyperliquidTransaction:SendAsset)
// sourceDex / destinationDex: "" (perp), "spot", "evm"
// fromSubAccount: sub-account address or "" for master
// For unified accounts: sourceDex MUST be "spot"
// Self-transfer → "Invalid send"
// Cross-user transfer → { status: "ok", response: { type: "default" } }
export interface HlSendAssetAction {
  type:              'sendAsset';
  hyperliquidChain:  'Mainnet' | 'Testnet';
  signatureChainId:  string;
  destination:       string;
  sourceDex:         string;   // "" | "spot" | "evm"
  destinationDex:    string;   // "" | "spot" | "evm"
  token:             string;
  amount:            string;
  fromSubAccount:    string;   // "" or sub-account address
  nonce:             number;
}

// agentSendAsset — sendAsset signed by an agent wallet (Pattern A — L1 Agent)
// IMPORTANT: action has NO hyperliquidChain / signatureChainId fields
// The agent can only send to the master account or its sub-accounts
// Error: "Agent can only send asset to same user or their sub-accounts."
export interface HlAgentSendAssetAction {
  type:           'agentSendAsset';
  // NO hyperliquidChain, NO signatureChainId — Pattern A
  destination:    string;
  sourceDex:      string;
  destinationDex: string;
  token:          string;
  amount:         string;
  fromSubAccount: string;
  nonce:          number;
}

// sendToEvmWithData — send token from HyperCore to HyperEVM with calldata
// Signing: Pattern B (HyperliquidTransaction:SendToEvmWithData)
// CRITICAL: destinationChainId is uint32 in EIP-712 (NOT uint64)
//   998 = testnet HyperEVM, 999 = mainnet HyperEVM
// data: hex bytes, "0x" for plain transfer
// addressEncoding: "hex" | "base58"
// Success: { status: "ok", response: { type: "default" } }
export interface HlSendToEvmWithDataAction {
  type:                 'sendToEvmWithData';
  hyperliquidChain:     'Mainnet' | 'Testnet';
  signatureChainId:     string;
  token:                string;
  amount:               string;
  sourceDex:            string;        // "" | "spot"
  destinationRecipient: string;        // EVM contract/wallet address
  addressEncoding:      'hex' | 'base58';
  destinationChainId:   number;        // uint32: 998 testnet, 999 mainnet
  gasLimit:             number;        // uint64
  data:                 string;        // hex bytes e.g. "0x"
  nonce:                number;
}

// ── Spot clearinghouse state response (new /info endpoint) ────────────────────
// Discovered from probe captures 26/27 (spotClearinghouseState).

export interface HlSpotClearinghouseState {
  balances: HlSpotBalance[];
  tokenToAvailableAfterMaintenance: [number, string][];
}

export interface HlSpotBalance {
  coin:     string;
  token:    number;
  total:    string;
  hold:     string;
  entryNtl: string;
}
// ─────────────────────────────────────────────────────────────────────────────
// API wallets / builder / referrals
// Append these to the bottom of src/types/hl.ts
// All shapes confirmed from HL docs and Python/Go SDK source.
// ─────────────────────────────────────────────────────────────────────────────

// approveAgent — authorize an API wallet (agent) to sign on behalf of master
// Signing: Pattern B (user-signed, HyperliquidTransaction:ApproveAgent)
// Confirmed shape from Dwellir docs:
// { type, signatureChainId, hyperliquidChain, agentAddress, agentName?, nonce }
// agentName omitted = unnamed agent (max 1 per account)
// agentName present = named agent (max 10, same name replaces previous)
// agentAddress = zero address (0x000...000) = revoke that agent
// Success: { status: "ok", response: { type: "default" } }
export interface HlApproveAgentAction {
  type:              'approveAgent';
  hyperliquidChain:  'Mainnet' | 'Testnet';
  signatureChainId:  string;
  agentAddress:      string;
  agentName?:        string;   // omit or empty for unnamed agent
  nonce:             number;
}

// approveBuilderFee — set max fee rate for a builder address
// Signing: Pattern B (user-signed, HyperliquidTransaction:ApproveBuilderFee)
// MUST be signed by master wallet, not an agent wallet.
// Confirmed shape from Python SDK:
// { type, maxFeeRate, builder, nonce }
// maxFeeRate format: "0.001%" (string, not numeric)
// Success: { status: "ok", response: { type: "default" } }
export interface HlApproveBuilderFeeAction {
  type:        'approveBuilderFee';
  maxFeeRate:  string;   // e.g. "0.001%"
  builder:     string;   // builder wallet address
  nonce:       number;
}

// setReferrer — record a referral code for this user
// Signing: Pattern A (L1 Agent)
// Confirmed shape from SDK: { type, code }
// code: alphanumeric referral code string
// Success: { status: "ok", response: { type: "default" } }
export interface HlSetReferrerAction {
  type: 'setReferrer';
  code: string;
}

// ── /info response types ──────────────────────────────────────────────────────

// extraAgents response — array of approved agents for a user
// Confirmed shape from Dwellir docs
export interface HlExtraAgent {
  address:    string;
  name:       string;       // empty string for unnamed agent
  validUntil: number | null;
}

// maxBuilderFee response
export interface HlMaxBuilderFee {
  maxFeeRate: string;
}

// builderFeeApproval response
export type HlBuilderFeeApproval =
  | { builder: string; maxFeeRate: string; approved: true }
  | { approved: false };

// referral response
export interface HlReferral {
  referrerState: {
    data:  { code: string; builderCode: string | null } | null;
    stage: 'percentageReferrer' | 'noReferrer';
  };
  referredBy:    { referrer: string; code: string } | null;
  cumVlm:        string;
  rewardHistory: unknown[];
}
// ─────────────────────────────────────────────────────────────────────────────
// TASK 4 ADDITIONS — Staking / Delegation
// Append to the bottom of src/types/hl.ts
// Field shapes confirmed from Go SDK (sonirico/go-hyperliquid) and HL node README.
// ─────────────────────────────────────────────────────────────────────────────

// cDeposit — move HYPE from spot balance into staking account
// Signing: Pattern A (L1 Agent)
// Confirmed shape from Go SDK: { type, wei }
// `wei` is integer, 1 HYPE = 100_000_000 wei (1e8)
// Success: { status: "ok", response: { type: "default" } }
export interface HlCDepositAction {
  type: 'cDeposit';
  wei:  number;   // integer wei amount
}

// cWithdraw — initiate 7-day unstake queue
// Signing: Pattern A (L1 Agent)
// Confirmed shape from Go SDK: { type, wei }
// HYPE deducted from staking balance immediately, returned after 7 days.
// Success: { status: "ok", response: { type: "default" } }
export interface HlCWithdrawAction {
  type: 'cWithdraw';
  wei:  number;   // integer wei amount
}

// tokenDelegate — delegate or undelegate staked HYPE to/from a validator
// Signing: Pattern A (L1 Agent)
// Confirmed shape from Go SDK: { type, validator, wei, isUndelegate }
// 1-day lockup: cannot undelegate within 1 day of delegating.
// Success: { status: "ok", response: { type: "default" } }
export interface HlTokenDelegateAction {
  type:         'tokenDelegate';
  validator:    string;    // validator wallet address
  wei:          number;    // integer wei amount
  isUndelegate: boolean;   // false = delegate, true = undelegate
}

// ── /info response types ──────────────────────────────────────────────────────

// delegations response — array of active delegations
export interface HlDelegation {
  validator:            string;
  amount:               string;   // HYPE (not wei)
  lockedUntilTimestamp: number;   // unix ms
  nSince:               number;   // unix ms, when delegated
}

// delegatorSummary response
export interface HlDelegatorSummary {
  delegated:              string;   // HYPE currently delegated
  undelegated:            string;   // HYPE in staking account (not delegated)
  totalPendingWithdrawal: string;   // HYPE in 7-day unstake queue
  nPendingWithdrawals:    number;
}

// delegatorHistory response — array of staking events
export interface HlDelegatorHistoryEntry {
  type:      'delegate' | 'undelegate' | 'cDeposit' | 'cWithdraw' | 'withdrawalComplete';
  validator: string | null;
  amount:    string;    // HYPE
  time:      number;    // unix ms
}

// delegatorRewards response
export interface HlDelegatorRewards {
  pendingRewards: string;
  totalRewards:   string;
  rewardHistory:  unknown[];
}
