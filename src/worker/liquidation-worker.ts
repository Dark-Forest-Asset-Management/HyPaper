/**
 * LiquidationWorker — continuous equity monitor.
 *
 * Hooks into the price-update event bus (same EventEmitter the rest of the
 * worker stack uses). On every `mids` event it runs the full liquidation
 * check across all active users.
 *
 * Design follows FundingWorker (funding-worker.ts) and ScheduleCancelWorker
 * (index.ts) patterns exactly:
 *   • start() / stop() lifecycle methods.
 *   • Errors are caught and logged — never crash the process.
 *   • A fallback polling interval (POLL_INTERVAL_MS) handles the edge case
 *     where the WS stream is temporarily silent.
 *
 * Concurrency guard: `running` flag prevents overlapping tick() calls if a
 * price burst arrives faster than the check completes.
 */

import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import { checkAndLiquidateAll } from '../engine/liquidation.js';

export class LiquidationWorker {
  private eventBus: EventEmitter;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;

  /** Fallback poll interval — fires even if the WS stream goes quiet. */
  private readonly POLL_INTERVAL_MS = 5_000;

  constructor(eventBus: EventEmitter) {
    this.eventBus = eventBus;
  }

  start(): void {
    logger.info({ pollIntervalMs: this.POLL_INTERVAL_MS }, 'LiquidationWorker started');

    // Primary trigger: run on every price update (same tick the matcher uses).
    this.eventBus.on('mids', this.onPriceUpdate);

    // Fallback: periodic poll in case WS is silent.
    this.pollTimer = setInterval(() => void this.tick(), this.POLL_INTERVAL_MS);

    // Fire immediately so the first check doesn't wait for the first tick.
    void this.tick();
  }

  stop(): void {
    this.eventBus.off('mids', this.onPriceUpdate);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('LiquidationWorker stopped');
  }

  /** Arrow function so `this` is bound correctly when used as an event listener. */
  private onPriceUpdate = (): void => {
    void this.tick();
  };

  private async tick(): Promise<void> {
    // Guard: skip if a previous tick is still running.
    if (this.running) return;
    this.running = true;
    try {
      await checkAndLiquidateAll();
    } catch (err) {
      logger.error({ err }, 'LiquidationWorker tick failed');
    } finally {
      this.running = false;
    }
  }
}
