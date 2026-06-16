import { EventEmitter } from 'node:events';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import type { HlAllMids, HlActiveAssetCtx, HlL2Book } from '../types/hl.js';

export type PriceUpdateCallback = () => void;

export class PriceUpdater {
  private onUpdate: PriceUpdateCallback;
  private eventBus: EventEmitter;

  constructor(onUpdate: PriceUpdateCallback, eventBus: EventEmitter) {
    this.onUpdate = onUpdate;
    this.eventBus = eventBus;
  }

  async handleMessage(channel: string, data: unknown): Promise<void> {
    switch (channel) {
      case 'allMids':
        await this.handleAllMids(data as HlAllMids);
        break;
      case 'activeAssetCtx':
        await this.handleActiveAssetCtx(data as HlActiveAssetCtx);
        break;
      case 'l2Book':
        await this.handleL2Book(data as HlL2Book);
        break;
      // Ephemeral market feeds relayed verbatim to /ws subscribers (1.2b).
      case 'trades':
        this.handleTrades(data);
        break;
      case 'bbo':
        this.handleBbo(data);
        break;
      case 'candle':
        this.handleCandle(data);
        break;
    }
  }

  private handleTrades(data: unknown): void {
    const arr = data as Array<{ coin?: string }>;
    if (!Array.isArray(arr) || arr.length === 0 || !arr[0]?.coin) return;
    this.eventBus.emit('trades', { coin: arr[0].coin, trades: arr });
  }

  private handleBbo(data: unknown): void {
    const d = data as { coin?: string };
    if (!d?.coin) return;
    this.eventBus.emit('bbo', { coin: d.coin, frame: d });
  }

  private handleCandle(data: unknown): void {
    const d = data as { s?: string; i?: string };
    if (!d?.s || !d?.i) return;
    this.eventBus.emit('candle', { coin: d.s, interval: d.i, frame: d });
  }

  private async handleAllMids(data: HlAllMids): Promise<void> {
    const mids = data.mids;
    if (!mids || typeof mids !== 'object') return;

    const entries = Object.entries(mids);
    if (entries.length === 0) return;

    const pipeline = redis.pipeline();
    const args: string[] = [];
    for (const [coin, px] of entries) {
      args.push(coin, px);
    }
    pipeline.hset(KEYS.MARKET_MIDS, ...args);
    await pipeline.exec();

    this.eventBus.emit('mids', { mids });
    this.onUpdate();
  }

  private async handleActiveAssetCtx(data: HlActiveAssetCtx): Promise<void> {
    if (!data.coin || !data.ctx) return;

    const ctx = data.ctx;
    const pipeline = redis.pipeline();
    pipeline.hset(KEYS.MARKET_CTX(data.coin),
      'markPx', ctx.markPx ?? '',
      'midPx', ctx.midPx ?? '',
      'oraclePx', ctx.oraclePx ?? '',
      'funding', ctx.funding ?? '',
      'openInterest', ctx.openInterest ?? '',
      'prevDayPx', ctx.prevDayPx ?? '',
      'dayNtlVlm', ctx.dayNtlVlm ?? '',
      'premium', ctx.premium ?? '',
    );

    const livePx = ctx.midPx ?? ctx.markPx;
    if (livePx) {
      pipeline.hset(KEYS.MARKET_MIDS, data.coin, livePx);
    }

    await pipeline.exec();

    // Relay the full ctx frame to activeAssetCtx /ws subscribers (1.2b).
    this.eventBus.emit('activeAssetCtx', { coin: data.coin, ctx: data.ctx });

    if (livePx) {
      this.eventBus.emit('mids', { mids: { [data.coin]: livePx } });
      this.onUpdate();
    }
  }

  private async handleL2Book(data: HlL2Book): Promise<void> {
    if (!data.coin) return;
    await redis.set(KEYS.MARKET_L2(data.coin), JSON.stringify(data));
    this.eventBus.emit('l2book', { coin: data.coin, levels: data.levels, time: data.time });
  }

  async seedMids(mids: Record<string, string>): Promise<void> {
    const entries = Object.entries(mids);
    if (entries.length === 0) return;

    const args: string[] = [];
    for (const [coin, px] of entries) {
      args.push(coin, px);
    }
    await redis.hset(KEYS.MARKET_MIDS, ...args);
    logger.info({ count: entries.length }, 'Seeded mids');
  }
}
