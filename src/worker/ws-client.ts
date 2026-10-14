import WebSocket from 'ws';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export type WsMessageHandler = (channel: string, data: unknown) => void;

// HL closes a socket it has not sent anything on for 60 s and expects
// `{"method":"ping"}` → `{"channel":"pong"}` (docs, "Timeouts and
// heartbeats"). A socket can also stay OPEN and silent (documented on the
// bridge: 39 h / 9.5 h), which froze every paper mid with no log line
// (2026-10-13 review, M17). Both are handled the same way the repo's
// CLAUDE.md prescribes for standalone clients: track last-message time,
// ping when quiet, terminate + reconnect when stale.
const PING_AFTER_QUIET_MS = 30_000;
const STALE_AFTER_MS = 90_000;
const HEARTBEAT_TICK_MS = 10_000;

export class HlWebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectDelay: number;
  private shouldReconnect = true;
  private handler: WsMessageHandler;
  private subscriptions: object[] = [];
  private lastMessageAt = 0;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(handler: WsMessageHandler) {
    this.handler = handler;
    this.reconnectDelay = config.WS_RECONNECT_MIN_MS;
  }

  connect(): void {
    logger.info({ url: config.HL_WS_URL }, 'Connecting to HL WebSocket');
    this.ws = new WebSocket(config.HL_WS_URL);

    this.ws.on('open', () => {
      logger.info('HL WebSocket connected');
      this.reconnectDelay = config.WS_RECONNECT_MIN_MS;
      this.lastMessageAt = Date.now();
      this.startHeartbeat();
      this.sendSubscriptions();
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      this.lastMessageAt = Date.now();   // pongs count too — they carry no data
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.channel && msg.data) {
          this.handler(msg.channel, msg.data);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to parse WS message');
      }
    });

    this.ws.on('close', () => {
      logger.warn('HL WebSocket closed');
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      logger.error({ err }, 'HL WebSocket error');
    });
  }

  subscribe(subscription: object): void {
    this.subscriptions.push(subscription);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'subscribe', subscription }));
    }
  }

  private sendSubscriptions(): void {
    for (const sub of this.subscriptions) {
      this.ws?.send(JSON.stringify({ method: 'subscribe', subscription: sub }));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const quiet = Date.now() - this.lastMessageAt;
      if (quiet >= STALE_AFTER_MS) {
        logger.warn({ quietMs: quiet }, '[hl-ws] stale — no message from HL, terminating for reconnect');
        this.stopHeartbeat();
        ws.terminate();   // fires 'close' → scheduleReconnect
        return;
      }
      if (quiet >= PING_AFTER_QUIET_MS) {
        try { ws.send(JSON.stringify({ method: 'ping' })); } catch { /* close handler takes over */ }
      }
    }, HEARTBEAT_TICK_MS);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    logger.info({ delay: this.reconnectDelay }, 'Scheduling WS reconnect');
    setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, config.WS_RECONNECT_MAX_MS);
  }

  close(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.ws?.close();
  }
}
