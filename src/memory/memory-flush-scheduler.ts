/**
 * MemoryFlushScheduler — the background tick that deposits idle conversations.
 *
 * The scheduler is deliberately dumb: it wakes up, asks the MemoryService to
 * flush whatever is due, and forgets about it. Every failure is contained: a
 * scheduler tick never fails a conversation, never fails a task, and never
 * throws out of the timer callback.
 *
 * When memory is disabled the scheduler does not even exist: there is no
 * sidecar, no request and no cost (design D5).
 */

import type { MemoryService } from './memory-service.js';

export interface MemoryFlushSchedulerOptions {
  service: MemoryService;
  accountId: string;
  intervalMs?: number;
  now?: () => number;
  logger?: (message: string) => void;
}

export class MemoryFlushScheduler {
  private timer: NodeJS.Timeout | null = null;
  /** The in-flight tick, so shutdown can wait for it instead of racing it. */
  private tickWork: Promise<void> | null = null;
  private readonly intervalMs: number;
  private readonly logger: (message: string) => void;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: MemoryFlushSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.logger = options.logger ?? (() => undefined);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop scheduling. Does not wait for the in-flight tick; use `drain` for that. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  get status(): { lastRunAt: number | null; lastError: string | null } {
    return { lastRunAt: this.lastRunAt, lastError: this.lastError };
  }

  /** One periodic pass. Never throws. */
  async tick(): Promise<void> {
    if (this.tickWork) return this.tickWork;
    this.tickWork = (async () => {
      try {
        await this.options.service.flushPending({ accountId: this.options.accountId });
        this.lastError = null;
      } catch (error) {
        this.lastError = (error as Error).message;
        this.logger(`memory flush scheduler tick failed: ${this.lastError}`);
      } finally {
        this.lastRunAt = (this.options.now ?? Date.now)();
      }
    })();
    try {
      await this.tickWork;
    } finally {
      this.tickWork = null;
    }
  }

  /**
   * Final deposition before shutdown (design §5.2: `Server 关闭` is a fallback
   * trigger).
   *
   * Stops scheduling, waits for any in-flight tick, then deposits everything
   * still pending regardless of the idle window. Never throws: a failed memory
   * deposition must not block Server shutdown.
   */
  async drain(): Promise<{ flushed: number; conversations: number; error?: string }> {
    this.stop();
    try {
      await this.tickWork;
    } catch {
      // The tick already contains its own errors; nothing to do here.
    }
    try {
      const outcomes = await this.options.service.flushAll({ accountId: this.options.accountId });
      const flushed = outcomes.reduce((total, outcome) => total + outcome.flushed, 0);
      this.lastRunAt = (this.options.now ?? Date.now)();
      return { flushed, conversations: outcomes.length };
    } catch (error) {
      const message = (error as Error).message;
      this.lastError = message;
      this.logger(`memory shutdown flush failed: ${message}`);
      return { flushed: 0, conversations: 0, error: message };
    }
  }
}
