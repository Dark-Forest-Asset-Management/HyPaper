import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { mul, add, neg, isZero } from '../utils/math.js';
import { recordFunding } from '../store/pg-sink.js';

export class FundingWorker {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      this.applyFunding().catch((err) => {
        logger.error({ err }, 'Funding worker error');
      });
    }, config.FUNDING_INTERVAL_MS);
    logger.info({ intervalMs: config.FUNDING_INTERVAL_MS }, 'Funding worker started');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Funding worker stopped');
    }
  }

  async applyFunding(): Promise<void> {
    if (!config.FUNDING_ENABLED) return;

    const userIds = await redis.smembers(KEYS.USERS_ACTIVE);
    if (userIds.length === 0) return;

    for (const userId of userIds) {
      const assets = await redis.smembers(KEYS.USER_POSITIONS(userId));
      if (assets.length === 0) {
        // No positions — lazy cleanup
        await redis.srem(KEYS.USERS_ACTIVE, userId);
        continue;
      }

      const pipeline = redis.pipeline();
      let hasCharge = false;

      for (const assetStr of assets) {
        const asset = parseInt(assetStr, 10);
        const posKey = KEYS.USER_POS(userId, asset);
        const posData = await redis.hgetall(posKey);

        const szi = posData.szi ?? '0';
        if (isZero(szi)) continue;

        const coin = posData.coin;
        if (!coin) continue;

        // Read funding rate and mark price from market context
        const ctxData = await redis.hgetall(KEYS.MARKET_CTX(coin));
        const fundingRate = ctxData.funding;
        if (!fundingRate || isZero(fundingRate)) continue;

        const markPx = ctxData.markPx;
        if (!markPx || isZero(markPx)) continue;

        // fundingCharge = szi × markPx × fundingRate
        // Longs pay when rate is positive (charge is positive for longs)
        const fundingCharge = mul(mul(szi, markPx), fundingRate);

        const oldCumFunding = posData.cumFunding ?? '0';
        const oldCumFundingSinceOpen = posData.cumFundingSinceOpen ?? '0';
        const oldCumFundingSinceChange = posData.cumFundingSinceChange ?? '0';

        // Deduct from balance (neg because longs pay positive rate)
        pipeline.hincrbyfloat(KEYS.USER_ACCOUNT(userId), 'balance', neg(fundingCharge));

        // Update cumulative funding on position
        pipeline.hset(posKey,
          'cumFunding', add(oldCumFunding, fundingCharge),
          'cumFundingSinceOpen', add(oldCumFundingSinceOpen, fundingCharge),
          'cumFundingSinceChange', add(oldCumFundingSinceChange, fundingCharge),
        );

        hasCharge = true;

        // Persist the funding payment for /info userFunding. usdc is the
        // signed account delta (negative = user paid), matching HL.
        recordFunding(userId, {
          time: Date.now(),
          coin,
          usdc: neg(fundingCharge),
          szi,
          fundingRate,
          nSamples: 1,
        });

        logger.debug({
          userId,
          coin,
          szi,
          fundingRate,
          fundingCharge,
        }, 'Applied funding');
      }

      if (hasCharge) {
        await pipeline.exec();
      }
    }
  }
}
