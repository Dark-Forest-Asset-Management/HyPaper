import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import { HlWebSocketClient } from './ws-client.js';
import { PriceUpdater } from './price-updater.js';
import { OrderMatcher } from './order-matcher.js';
import { FundingWorker } from './funding-worker.js';
import type { HlMeta, HlAssetCtx } from '../types/hl.js';

export const eventBus = new EventEmitter();

export class Worker {
  private wsClient: HlWebSocketClient | null = null;
  private priceUpdater: PriceUpdater;
  private orderMatcher: OrderMatcher;
  private fundingWorker: FundingWorker;

  constructor() {
    this.orderMatcher = new OrderMatcher(eventBus);
    this.fundingWorker = new FundingWorker();
    this.priceUpdater = new PriceUpdater(() => {
      // Fire-and-forget match on every price update
      this.orderMatcher.matchAll();
    }, eventBus);

    this.wsClient = new HlWebSocketClient((channel, data) => {
      this.priceUpdater.handleMessage(channel, data);
    });
  }

  async start(): Promise<void> {
    logger.info('Starting worker...');

    // Fetch initial meta + prices from HL HTTP API
    await this.seedMarketData();

    // Connect WebSocket and subscribe to main + sub-DEX mids.
    // Sub-DEX mids live in their own keyspace (allMids without a `dex`
    // param returns main DEX only). We add one allMids subscription per
    // perp DEX so sub-DEX assets like `xyz:AAPL` get live mark prices.
    this.wsClient!.connect();
    this.wsClient!.subscribe({ type: 'allMids' });
    this.wsClient!.subscribe({ type: 'activeAssetCtx' });
    try {
      const perpDexsRaw = await redis.get(KEYS.MARKET_PERPDEXS);
      if (perpDexsRaw) {
        const dexList: Array<{ name: string } | null> = JSON.parse(perpDexsRaw);
        for (const d of dexList) {
          if (d && d.name) this.wsClient!.subscribe({ type: 'allMids', dex: d.name });
        }
      }
    } catch (e) {
      logger.warn({ err: e }, 'Failed to subscribe sub-DEX mids');
    }

    this.fundingWorker.start();

    logger.info('Worker started');
  }

  private async seedMarketData(): Promise<void> {
    try {
      // Fetch meta (universe info)
      const metaRes = await fetch(`${config.HL_API_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'meta' }),
      });
      const meta: HlMeta = await metaRes.json() as HlMeta;
      await redis.set(KEYS.MARKET_META, JSON.stringify(meta));
      logger.info({ assets: meta.universe.length }, 'Seeded market meta');

      // Fetch metaAndAssetCtxs for initial prices
      const ctxRes = await fetch(`${config.HL_API_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      const ctxData = await ctxRes.json() as [HlMeta, HlAssetCtx[]];
      const assetCtxs = ctxData[1];

      // Build initial mids from the best live price available.
      const mids: Record<string, string> = {};
      for (let i = 0; i < meta.universe.length && i < assetCtxs.length; i++) {
        const coin = meta.universe[i].name;
        const ctx = assetCtxs[i];
        const livePx = ctx.midPx ?? ctx.markPx;
        if (livePx) {
          mids[coin] = livePx;
        }
        // Store asset context
        await redis.hset(KEYS.MARKET_CTX(coin),
          'markPx', ctx.markPx ?? '',
          'midPx', ctx.midPx ?? '',
          'oraclePx', ctx.oraclePx ?? '',
          'funding', ctx.funding ?? '',
          'openInterest', ctx.openInterest ?? '',
          'prevDayPx', ctx.prevDayPx ?? '',
          'dayNtlVlm', ctx.dayNtlVlm ?? '',
          'premium', ctx.premium ?? '',
        );
      }

      await this.priceUpdater.seedMids(mids);

      // Fetch allMids for current mid prices
      const midsRes = await fetch(`${config.HL_API_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
      });
      const allMids = await midsRes.json() as Record<string, string>;
      await this.priceUpdater.seedMids(allMids);

      // ── Sub-DEX seeding ──
      // Cache the perpDexs list so resolveAssetCoin can decode HL's
      // `100_000 + perpDexIdx*10_000 + uIdx` encoding. For each non-null
      // sub-DEX, fetch its meta + ctxs + mids and cache under MARKET_META_DEX.
      try {
        const perpDexsRes = await fetch(`${config.HL_API_URL}/info`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'perpDexs' }),
        });
        const perpDexs = await perpDexsRes.json() as Array<{ name: string; fullName: string } | null>;
        await redis.set(KEYS.MARKET_PERPDEXS, JSON.stringify(perpDexs));
        logger.info({ count: perpDexs.filter((d) => d != null).length }, 'Seeded perpDexs');

        for (const dex of perpDexs) {
          if (!dex || !dex.name) continue;
          try {
            const subRes = await fetch(`${config.HL_API_URL}/info`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: dex.name }),
            });
            const subData = await subRes.json() as [HlMeta, HlAssetCtx[]];
            const [subMeta, subCtxs] = subData;
            await redis.set(KEYS.MARKET_META_DEX(dex.name), JSON.stringify(subMeta));

            const subMids: Record<string, string> = {};
            for (let i = 0; i < subMeta.universe.length && i < subCtxs.length; i++) {
              const coin = subMeta.universe[i].name;  // already prefixed (e.g. "xyz:AAPL")
              const ctx = subCtxs[i];
              const livePx = ctx.midPx ?? ctx.markPx;
              if (livePx) subMids[coin] = livePx;
              await redis.hset(KEYS.MARKET_CTX(coin),
                'markPx', ctx.markPx ?? '',
                'midPx', ctx.midPx ?? '',
                'oraclePx', ctx.oraclePx ?? '',
                'funding', ctx.funding ?? '',
                'openInterest', ctx.openInterest ?? '',
                'prevDayPx', ctx.prevDayPx ?? '',
                'dayNtlVlm', ctx.dayNtlVlm ?? '',
                'premium', ctx.premium ?? '',
              );
            }
            await this.priceUpdater.seedMids(subMids);
            logger.info({ dex: dex.name, assets: subMeta.universe.length }, 'Seeded sub-DEX meta');
          } catch (e) {
            logger.warn({ err: e, dex: dex.name }, 'Failed to seed sub-DEX');
          }
        }
      } catch (e) {
        logger.warn({ err: e }, 'Failed to seed perpDexs — sub-DEX trading disabled');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to seed market data');
      throw err;
    }
  }

  stop(): void {
    this.fundingWorker.stop();
    this.wsClient?.close();
    logger.info('Worker stopped');
  }
}
