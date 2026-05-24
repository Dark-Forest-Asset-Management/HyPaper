import type { PaperOrder, PaperFill } from '../types/order.js';

// === Inbound (client → server) ===

export interface WsSubscribeMessage {
  method: 'subscribe';
  subscription: WsSubscription;
}

export interface WsUnsubscribeMessage {
  method: 'unsubscribe';
  subscription: WsSubscription;
}

export type WsInboundMessage = WsSubscribeMessage | WsUnsubscribeMessage;

export type WsSubscription =
  | { type: 'allMids' }
  | { type: 'l2Book'; coin: string }
  | { type: 'orderUpdates'; user: string }
  | { type: 'userFills'; user: string }
  // Combined user-state push. Mirrors HL prod's webData2 channel —
  // emits clearinghouseState + openOrders on every change. Replaces
  // slushy's 2s REST poll for those.
  | { type: 'webData2'; user: string }
  // Market feeds relayed verbatim from HL (1.2b).
  | { type: 'trades'; coin: string }
  | { type: 'bbo'; coin: string }
  | { type: 'candle'; coin: string; interval: string }
  | { type: 'activeAssetCtx'; coin: string }
  | { type: 'notification'; user: string }
  // User feeds sourced from paper state (1.2c).
  | { type: 'userEvents'; user: string }
  | { type: 'userFundings'; user: string }
  | { type: 'userNonFundingLedgerUpdates'; user: string }
  | { type: 'activeAssetData'; user: string; coin: string };

// === Outbound (server → client) ===

export interface WsAllMidsMessage {
  channel: 'allMids';
  data: { mids: Record<string, string> };
}

export interface WsL2BookMessage {
  channel: 'l2Book';
  data: {
    coin: string;
    levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>];
    time: number;
  };
}

export interface WsOrderUpdateMessage {
  channel: 'orderUpdates';
  data: Array<{
    order: {
      coin: string;
      side: 'B' | 'A';
      limitPx: string;
      sz: string;
      oid: number;
      timestamp: number;
      origSz: string;
      cloid?: string;
    };
    status: string;
    statusTimestamp: number;
  }>;
}

export interface WsUserFillsMessage {
  channel: 'userFills';
  data: {
    isSnapshot: boolean;
    user: string;
    fills: PaperFill[];
  };
}

export type WsOutboundMessage =
  | WsAllMidsMessage
  | WsL2BookMessage
  | WsOrderUpdateMessage
  | WsUserFillsMessage;

// === Event bus payloads ===

export interface MidsEvent {
  mids: Record<string, string>;
}

export interface L2BookEvent {
  coin: string;
  levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>];
  time: number;
}

export interface FillEvent {
  userId: string;
  fill: PaperFill;
}

export interface OrderUpdateEvent {
  userId: string;
  order: PaperOrder;
  status: string;
}
