import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { redis } from "../store/redis.js";
import { KEYS } from "../store/keys.js";
import { logger } from "../utils/logger.js";
import { HlWebSocketClient } from "./ws-client.js";
import { PriceUpdater } from "./price-updater.js";
import { OrderMatcher } from "./order-matcher.js";
import { FundingWorker } from "./funding-worker.js";
import { sweepStakingQueue } from "../engine/staking.js";
import type { HlMeta, HlAssetCtx } from "../types/hl.js";

export const eventBus = new EventEmitter();

// ─── ScheduleCancelWorker ─────────────────────────────────────────────────────
//
// Implements the "dead man's switch" for scheduleCancel actions.
//
// When a user calls scheduleCancel with a future `time`, the exchange router
// stores that deadline in Redis at key `user:{wallet}:schedule_cancel`.
//
// This worker polls every POLL_INTERVAL_MS and:
//   1. Scans all `user:*:schedule_cancel` keys in Redis
//   2. For each one whose deadline has passed:
//      a. Loads all open orders for that wallet
//      b. Cancels them all
//      c. Deletes the schedule_cancel key so it doesn't fire again
//
// Real HL enforces a max of 10 triggers per day and resets at 00:00 UTC.
// HyPaper doesn't track that count — it's a v1 approximation.

class ScheduleCancelWorker {
  private timer: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 5_000; // check every 5 seconds

  start(): void {
    logger.info(
      { intervalMs: this.POLL_INTERVAL_MS },
      "ScheduleCancel worker started",
    );
    this.timer = setInterval(() => void this.tick(), this.POLL_INTERVAL_MS);
    // Fire immediately so the first check doesn't wait the full interval
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      // Scan all scheduled cancel keys.
      // Pattern: user:*:schedule_cancel
      // We use SCAN instead of KEYS to avoid blocking Redis on large datasets.
      let cursor = "0";
      const matchedKeys: string[] = [];

      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          "user:*:schedule_cancel",
          "COUNT",
          100,
        );
        cursor = nextCursor;
        matchedKeys.push(...keys);
      } while (cursor !== "0");

      if (matchedKeys.length === 0) return;

      const nowMs = Date.now();

      for (const key of matchedKeys) {
        try {
          const timeStr = await redis.get(key);
          if (!timeStr) continue;

          const scheduledTime = parseInt(timeStr, 10);
          if (!Number.isFinite(scheduledTime)) continue;

          // Not yet time — skip
          if (nowMs < scheduledTime) continue;

          // Extract wallet address from key pattern: user:{wallet}:schedule_cancel
          // key = "user:0x4a1ae...:schedule_cancel"
          const parts = key.split(":");
          // parts[0] = "user", parts[1] = wallet address, parts[2] = "schedule_cancel"
          if (parts.length < 3) continue;
          const wallet = parts[1];

          logger.info(
            { wallet, scheduledTime, nowMs },
            "scheduleCancel deadline reached — cancelling all open orders",
          );

          // Get all open order IDs for this wallet from the user's sorted set
          const oidStrs = await redis.zrange(KEYS.USER_ORDERS(wallet), 0, -1);

          if (oidStrs.length > 0) {
            // Filter to only open orders by checking each order's status
            const cancels: Array<{ a: number; o: number }> = [];
            for (const oidStr of oidStrs) {
              const oid = parseInt(oidStr, 10);
              if (!Number.isFinite(oid)) continue;
              const orderData = await redis.hgetall(KEYS.ORDER(oid));
              if (orderData.status !== "open") continue;
              const asset = orderData.asset ? parseInt(orderData.asset, 10) : 0;
              cancels.push({ a: asset, o: oid });
            }

            if (cancels.length > 0) {
              const now2 = Date.now();
              const pipeline = redis.pipeline();
              for (const { o: oid } of cancels) {
                pipeline.hset(
                  KEYS.ORDER(oid),
                  "status",
                  "cancelled",
                  "updatedAt",
                  now2.toString(),
                );
                pipeline.srem(KEYS.ORDERS_OPEN, oid.toString());
                pipeline.srem(KEYS.ORDERS_TRIGGERS, oid.toString());
                pipeline.zrem(KEYS.ORDERS_EXPIRY, oid.toString()); // clean expiry set
              }
              await pipeline.exec();

              // Emit WebSocket cancellation event for each order
              // so Slushy frontend sees the update in real time
              for (const { o: oid, a: asset } of cancels) {
                const orderData = await redis.hgetall(KEYS.ORDER(oid));
                eventBus.emit("orderUpdate", {
                  userId: wallet,
                  order: {
                    oid,
                    coin: orderData.coin,
                    isBuy: orderData.isBuy === "true",
                    sz: orderData.sz,
                    limitPx: orderData.limitPx,
                    status: "cancelled",
                    asset,
                    userId: wallet,
                    orderType: orderData.orderType,
                    tif: orderData.tif,
                    reduceOnly: orderData.reduceOnly === "true",
                    grouping: orderData.grouping,
                    filledSz: orderData.filledSz ?? "0",
                    avgPx: orderData.avgPx ?? "0",
                    createdAt: parseInt(orderData.createdAt, 10),
                    updatedAt: now2,
                    cloid: orderData.cloid || undefined,
                  },
                  status: "cancelled",
                });
              }

              logger.info(
                { wallet, count: cancels.length, scheduledTime },
                "scheduleCancel: cancelled open orders",
              );
            }
          }

          // Delete the scheduled cancel key — it has fired, don't fire again
          await redis.del(key);
        } catch (err) {
          logger.error(
            { err, key },
            "scheduleCancel tick: error processing key",
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "scheduleCancel tick failed");
    }
  }
}

// ─── StakingWorker ────────────────────────────────────────────────────────────
//
// Sweeps the 7-day staking withdrawal queue every 60 seconds.
// When a cWithdraw entry's unlockTime has passed, this worker completes
// the withdrawal: moves HYPE back to the user's staking balance and removes
// the entry from the queue.
//
// Uses sweepStakingQueue() from engine/staking.ts which handles the Redis
// SCAN + zrangebyscore logic internally.

class StakingWorker {
  private timer: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 60_000; // check every 60 seconds

  start(): void {
    logger.info(
      { intervalMs: this.POLL_INTERVAL_MS },
      "Staking worker started",
    );
    this.timer = setInterval(() => void this.tick(), this.POLL_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      await sweepStakingQueue();
    } catch (err) {
      logger.error({ err }, "Staking worker tick failed");
    }
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export class Worker {
  private wsClient: HlWebSocketClient | null = null;
  private priceUpdater: PriceUpdater;
  private orderMatcher: OrderMatcher;
  private fundingWorker: FundingWorker;
  private scheduleCancelWorker: ScheduleCancelWorker;
  private stakingWorker: StakingWorker;

  constructor() {
    this.orderMatcher = new OrderMatcher(eventBus);
    this.fundingWorker = new FundingWorker();
    this.scheduleCancelWorker = new ScheduleCancelWorker();
    this.stakingWorker = new StakingWorker();
    this.priceUpdater = new PriceUpdater(() => {
      // Fire-and-forget match on every price update
      this.orderMatcher.matchAll();
    }, eventBus);

    this.wsClient = new HlWebSocketClient((channel, data) => {
      this.priceUpdater.handleMessage(channel, data);
    });
  }

  async start(): Promise<void> {
    logger.info("Starting worker...");

    // Fetch initial meta + prices from HL HTTP API
    await this.seedMarketData();

    // Connect WebSocket and subscribe to main + sub-DEX mids.
    // Sub-DEX mids live in their own keyspace (allMids without a `dex`
    // param returns main DEX only). We add one allMids subscription per
    // perp DEX so sub-DEX assets like `xyz:AAPL` get live mark prices.
    this.wsClient!.connect();
    this.wsClient!.subscribe({ type: "allMids" });
    this.wsClient!.subscribe({ type: "activeAssetCtx" });
    try {
      const perpDexsRaw = await redis.get(KEYS.MARKET_PERPDEXS);
      if (perpDexsRaw) {
        const dexList: Array<{ name: string } | null> = JSON.parse(perpDexsRaw);
        for (const d of dexList) {
          if (d && d.name)
            this.wsClient!.subscribe({ type: "allMids", dex: d.name });
        }
      }
    } catch (e) {
      logger.warn({ err: e }, "Failed to subscribe sub-DEX mids");
    }

    this.fundingWorker.start();
    this.scheduleCancelWorker.start();
    this.stakingWorker.start();

    // Subscribe l2Book over WS for coins with open/trigger orders so the
    // matcher reads fresh book depth from Redis (via price-updater's l2Book
    // handler) instead of HTTP-fetching HL public per fill. The HTTP path
    // (l2-cache.ts) remains as a hard-timeout-bounded fallback for coins
    // that aren't yet WS-subscribed (e.g. one-shot market orders).
    // Gated by L2_WS_ENABLED (default true): disabling it skips the
    // subscription, so getL2Book degrades to HTTP l2Book polling — the
    // original behavior, available as a no-redeploy rollback lever.
    if (config.L2_WS_ENABLED) {
      this.startL2Subscriptions();
    } else {
      logger.info('L2_WS_ENABLED=false — skipping l2Book WS subscription; getL2Book will use HTTP polling');
    }

    // Periodic HTTP mid trueup. Belt-and-suspenders against the case where
    // HL's WS allMids stream drops or stops delivering ticks for individual
    // sub-DEX coins (real bug seen 2026-05-19: xyz:MU stayed at its seed
    // value of 684.28 from yesterday while HL had moved through 720+ and
    // the user's SL trigger at 714.42 never fired because the matcher reads
    // from market:mids which the WS subscription wasn't updating).
    //
    // Strategy: every TRUEUP_INTERVAL_MS, hit HL HTTP `allMids` for main +
    // each sub-DEX. Bulk-write to Redis. Cheap — 1 HTTP request per DEX per
    // interval, returns every coin's current mid in a single response.
    // Doesn't replace the WS path (still cheaper for live ticks), just
    // ensures stale mids get refreshed on a bounded cadence.
    this.startMidTrueup();

    logger.info("Worker started");
  }

  // ─── L2 book WS subscriptions ────────────────────────────────────────────
  // Tracks which coins we've subscribed l2Book for. Grows as new coins get
  // open orders; we don't unsubscribe (bounded set per paper account — the
  // distinct coins traded is small). Reconciler runs on an interval so orders
  // placed after startup get an L2 subscription within L2_RECONCILE_MS.
  private l2Subscribed = new Set<string>();
  private l2ReconcileTimer: NodeJS.Timeout | null = null;
  private readonly L2_RECONCILE_MS = 5_000;

  private startL2Subscriptions(): void {
    const reconcile = async (): Promise<void> => {
      try {
        const coins = await this.getOpenOrderCoins();
        for (const coin of coins) {
          if (!this.l2Subscribed.has(coin)) {
            this.wsClient!.subscribe({ type: 'l2Book', coin });
            this.l2Subscribed.add(coin);
            logger.info({ coin }, 'Subscribed l2Book for open-order coin');
          }
        }
      } catch (e) {
        logger.debug({ err: (e as Error).message }, 'L2 subscription reconcile failed');
      }
    };
    this.l2ReconcileTimer = setInterval(reconcile, this.L2_RECONCILE_MS);
    void reconcile();
  }

  /** Distinct coins across open + trigger orders (the resting orders that
   *  need book depth when they eventually fill). */
  private async getOpenOrderCoins(): Promise<Set<string>> {
    const coins = new Set<string>();
    const oids = [
      ...(await redis.smembers(KEYS.ORDERS_OPEN)),
      ...(await redis.smembers(KEYS.ORDERS_TRIGGERS)),
    ];
    for (const oidStr of oids) {
      const coin = await redis.hget(KEYS.ORDER(parseInt(oidStr, 10)), 'coin');
      if (coin) coins.add(coin);
    }
    return coins;
  }

  private midTrueupTimer: NodeJS.Timeout | null = null;
  private readonly TRUEUP_INTERVAL_MS = 5_000;

  private startMidTrueup(): void {
    const tick = async (): Promise<void> => {
      try {
        // Main DEX
        await this.trueupOneDex(undefined);
        // Sub-DEXes from cached perpDexs list (already populated in seedMarketData)
        const perpDexsRaw = await redis.get(KEYS.MARKET_PERPDEXS);
        if (perpDexsRaw) {
          const dexList: Array<{ name: string } | null> =
            JSON.parse(perpDexsRaw);
          for (const d of dexList) {
            if (d && d.name) {
              try {
                await this.trueupOneDex(d.name);
              } catch (e) {
                logger.debug(
                  { err: (e as Error).message, dex: d.name },
                  "trueup sub-DEX failed",
                );
              }
            }
          }
        }
      } catch (e) {
        logger.debug({ err: (e as Error).message }, "trueup tick failed");
      }
    };
    this.midTrueupTimer = setInterval(tick, this.TRUEUP_INTERVAL_MS);
    // Fire once immediately so the first refresh doesn't wait the full interval
    void tick();
  }

  private async trueupOneDex(dex: string | undefined): Promise<void> {
    const body: { type: "allMids"; dex?: string } = { type: "allMids" };
    if (dex) body.dex = dex;
    const res = await fetch(`${config.HL_API_URL}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const mids = (await res.json()) as Record<string, string>;
    if (!mids || typeof mids !== "object") return;
    const entries = Object.entries(mids);
    if (entries.length === 0) return;
    const args: string[] = [];
    for (const [coin, px] of entries) {
      if (px) args.push(coin, String(px));
    }
    if (args.length === 0) return;
    await redis.hset(KEYS.MARKET_MIDS, ...args);
    // Wake the matcher so any trigger orders whose mid just refreshed get
    // re-evaluated immediately instead of waiting for the next WS tick.
    this.orderMatcher.matchAll();
  }

  private async seedMarketData(): Promise<void> {
    try {
      // Fetch meta (universe info)
      const metaRes = await fetch(`${config.HL_API_URL}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "meta" }),
      });
      const meta: HlMeta = (await metaRes.json()) as HlMeta;
      await redis.set(KEYS.MARKET_META, JSON.stringify(meta));
      logger.info({ assets: meta.universe.length }, "Seeded market meta");

      // Fetch metaAndAssetCtxs for initial prices
      const ctxRes = await fetch(`${config.HL_API_URL}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      });
      const ctxData = (await ctxRes.json()) as [HlMeta, HlAssetCtx[]];
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
        await redis.hset(
          KEYS.MARKET_CTX(coin),
          "markPx",
          ctx.markPx ?? "",
          "midPx",
          ctx.midPx ?? "",
          "oraclePx",
          ctx.oraclePx ?? "",
          "funding",
          ctx.funding ?? "",
          "openInterest",
          ctx.openInterest ?? "",
          "prevDayPx",
          ctx.prevDayPx ?? "",
          "dayNtlVlm",
          ctx.dayNtlVlm ?? "",
          "premium",
          ctx.premium ?? "",
        );
      }

      await this.priceUpdater.seedMids(mids);

      // Fetch allMids for current mid prices
      const midsRes = await fetch(`${config.HL_API_URL}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "allMids" }),
      });
      const allMids = (await midsRes.json()) as Record<string, string>;
      await this.priceUpdater.seedMids(allMids);

      // ── Sub-DEX seeding ──
      // Cache the perpDexs list so resolveAssetCoin can decode HL's
      // `100_000 + perpDexIdx*10_000 + uIdx` encoding. For each non-null
      // sub-DEX, fetch its meta + ctxs + mids and cache under MARKET_META_DEX.
      try {
        const perpDexsRes = await fetch(`${config.HL_API_URL}/info`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "perpDexs" }),
        });
        const perpDexs = (await perpDexsRes.json()) as Array<{
          name: string;
          fullName: string;
        } | null>;
        await redis.set(KEYS.MARKET_PERPDEXS, JSON.stringify(perpDexs));
        logger.info(
          { count: perpDexs.filter((d) => d != null).length },
          "Seeded perpDexs",
        );

        for (const dex of perpDexs) {
          if (!dex || !dex.name) continue;
          try {
            const subRes = await fetch(`${config.HL_API_URL}/info`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "metaAndAssetCtxs", dex: dex.name }),
            });
            const subData = (await subRes.json()) as [HlMeta, HlAssetCtx[]];
            const [subMeta, subCtxs] = subData;
            await redis.set(
              KEYS.MARKET_META_DEX(dex.name),
              JSON.stringify(subMeta),
            );

            const subMids: Record<string, string> = {};
            for (
              let i = 0;
              i < subMeta.universe.length && i < subCtxs.length;
              i++
            ) {
              const coin = subMeta.universe[i].name; // already prefixed (e.g. "xyz:AAPL")
              const ctx = subCtxs[i];
              const livePx = ctx.midPx ?? ctx.markPx;
              if (livePx) subMids[coin] = livePx;
              await redis.hset(
                KEYS.MARKET_CTX(coin),
                "markPx",
                ctx.markPx ?? "",
                "midPx",
                ctx.midPx ?? "",
                "oraclePx",
                ctx.oraclePx ?? "",
                "funding",
                ctx.funding ?? "",
                "openInterest",
                ctx.openInterest ?? "",
                "prevDayPx",
                ctx.prevDayPx ?? "",
                "dayNtlVlm",
                ctx.dayNtlVlm ?? "",
                "premium",
                ctx.premium ?? "",
              );
            }
            await this.priceUpdater.seedMids(subMids);
            logger.info(
              { dex: dex.name, assets: subMeta.universe.length },
              "Seeded sub-DEX meta",
            );
          } catch (e) {
            logger.warn({ err: e, dex: dex.name }, "Failed to seed sub-DEX");
          }
        }
      } catch (e) {
        logger.warn(
          { err: e },
          "Failed to seed perpDexs — sub-DEX trading disabled",
        );
      }
    } catch (err) {
      logger.error({ err }, "Failed to seed market data");
      throw err;
    }
  }

  stop(): void {
    if (this.midTrueupTimer) {
      clearInterval(this.midTrueupTimer);
      this.midTrueupTimer = null;
    }
    if (this.l2ReconcileTimer) {
      clearInterval(this.l2ReconcileTimer);
      this.l2ReconcileTimer = null;
    }
    this.fundingWorker.stop();
    this.scheduleCancelWorker.stop();
    this.stakingWorker.stop();
    this.wsClient?.close();
    logger.info("Worker stopped");
  }
}