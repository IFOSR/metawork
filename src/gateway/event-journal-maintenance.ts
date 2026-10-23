/**
 * Background read-model maintenance. It never owns navigation or lifecycle.
 *
 * A tick is a bounded sweep over the streams the journal index knows about.
 * The sweep reports whether it performed any work, so a fully converged install
 * can sleep instead of re-walking every stream at the stream-local rate
 * (2026-10-22 review §A1, corrected by the 2026-10-23 diagnostic review §3).
 */

/** One bounded maintenance batch for a single stream. */
export interface JournalMaintenancePass {
  /** False means the bounded batch needs another pass on this stream. */
  readonly done: boolean;
  /**
   * True when the pass performed durable maintenance work. `done` alone cannot
   * express this: the batch that finally converges a stream also returns true.
   */
  readonly didWork?: boolean;
}

export type JournalMaintenanceErrorStage = 'next_stream' | 'maintain';

export interface JournalMaintenanceErrorContext {
  readonly accountId: string;
  readonly conversationId: string | null;
  readonly stage: JournalMaintenanceErrorStage;
  /** Consecutive failures for this stream, including this one. */
  readonly attempts: number;
  /** Identical failures not reported since the previous report. */
  readonly suppressed: number;
  readonly outcome: 'reported' | 'suppressed';
}

export interface JournalMaintenanceRecoveryContext {
  readonly accountId: string;
  readonly conversationId: string;
  readonly failedAttempts: number;
  readonly suppressed: number;
}

export interface JournalMaintenanceDeps {
  readonly accountId: string;
  readonly nextStream: (accountId: string, afterConversationId: string) => string | null;
  readonly maintain: (
    accountId: string,
    conversationId: string,
  ) => Promise<JournalMaintenancePass | boolean>;
  readonly onError: (error: unknown, context: JournalMaintenanceErrorContext) => void;
  /** Reported once when a stream that failed at least once makes progress again. */
  readonly onRecovered?: (context: JournalMaintenanceRecoveryContext) => void;
  /** Delay before the next sweep while work remains. */
  readonly intervalMs?: number;
  /** Delay after a complete sweep that found no work anywhere. */
  readonly idleIntervalMs?: number;
  /** Wall-clock budget for one sweep, so a tick stays bounded. */
  readonly maxSweepMs?: number;
  /** Streams visited per sweep, so a large install still yields to the event loop. */
  readonly maxStreamsPerSweep?: number;
  readonly errorBackoffBaseMs?: number;
  readonly errorBackoffMaxMs?: number;
  /** Report one summary line per this many identical suppressed failures. */
  readonly errorReportEvery?: number;
}

const DEFAULTS = {
  intervalMs: 25,
  idleIntervalMs: 1_000,
  maxSweepMs: 40,
  maxStreamsPerSweep: 128,
  errorBackoffBaseMs: 500,
  errorBackoffMaxMs: 60_000,
  errorReportEvery: 100,
} as const;

const MAX_BATCHES_PER_STREAM = 4;
const MAX_SKIPPED_STREAMS = 4_096;

interface StreamFailure {
  /** Failure identity, so a new failure mode on a known stream is reported. */
  code: string;
  attempts: number;
  /** Failures not reported since the last report. */
  suppressed: number;
  retryAt: number;
}

export class EventJournalMaintenance {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private running = false;
  private cursor = '';
  private current: string | null = null;
  private consecutiveBatches = 0;
  private idle = false;
  private readonly failures = new Map<string, StreamFailure>();
  /** Backoff for the stream index itself, so a broken database is not polled. */
  private indexRetryAt = 0;
  private indexFailures = 0;

  constructor(private readonly deps: JournalMaintenanceDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.activeIntervalMs);
  }

  /** Wakes an idle loop as soon as the Runtime knows about new work. */
  wake(): void {
    if (!this.running || !this.idle) return;
    this.idle = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(this.activeIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.pending;
  }

  private get activeIntervalMs(): number {
    return this.deps.intervalMs ?? DEFAULTS.intervalMs;
  }

  private get idleIntervalMs(): number {
    return this.deps.idleIntervalMs ?? DEFAULTS.idleIntervalMs;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = this.sweep()
        .then(pass => { this.idle = !pass.didWork && pass.complete; })
        .catch(() => { this.idle = false; })
        .finally(() => {
          this.pending = null;
          this.schedule(this.idle ? this.idleIntervalMs : this.activeIntervalMs);
        });
    }, delayMs);
    this.timer.unref();
  }

  /**
   * One bounded sweep. `didWork` keeps the next tick on the active interval;
   * `complete` proves the cursor wrapped, which is what allows an idle sleep.
   * A sweep cut short by the per-tick budget is not evidence of idleness.
   */
  private async sweep(): Promise<{ didWork: boolean; complete: boolean }> {
    const started = Date.now();
    const maxSweepMs = this.deps.maxSweepMs ?? DEFAULTS.maxSweepMs;
    const maxStreams = this.deps.maxStreamsPerSweep ?? DEFAULTS.maxStreamsPerSweep;
    let didWork = false;
    let visited = 0;
    while (visited < maxStreams && Date.now() - started < maxSweepMs) {
      if (!this.current) {
        let next: string | null;
        try {
          next = this.nextEligibleStream();
        } catch (error) {
          // The stream index itself is unavailable. Report with stack and back
          // off on the idle interval instead of spinning.
          this.reportFailure(null, 'next_stream', error);
          this.cursor = '';
          return { didWork, complete: false };
        }
        if (!next) {
          this.cursor = '';
          return { didWork, complete: true };
        }
        this.current = next;
        this.consecutiveBatches = 0;
        visited += 1;
      }
      const conversationId = this.current;
      let pass: JournalMaintenancePass;
      try {
        pass = normalizePass(await this.deps.maintain(this.deps.accountId, conversationId));
      } catch (error) {
        this.reportFailure(conversationId, 'maintain', error);
        // One damaged stream must not starve every other stream.
        this.cursor = conversationId;
        this.current = null;
        this.consecutiveBatches = 0;
        continue;
      }
      this.reportRecovered(conversationId);
      if (pass.didWork || !pass.done) didWork = true;
      if (pass.done || ++this.consecutiveBatches >= MAX_BATCHES_PER_STREAM) {
        this.cursor = conversationId;
        this.current = null;
        this.consecutiveBatches = 0;
      }
    }
    return { didWork, complete: false };
  }

  private nextEligibleStream(): string | null {
    const now = Date.now();
    if (now < this.indexRetryAt) return null;
    for (let skipped = 0; skipped < MAX_SKIPPED_STREAMS; skipped += 1) {
      const candidate = this.deps.nextStream(this.deps.accountId, this.cursor);
      // A stream index that cannot advance past the cursor ends the sweep; it
      // also proves the sweep wrapped instead of looping on one stream.
      if (!candidate || candidate === this.cursor) return null;
      this.cursor = candidate;
      // The index answered, so a previous index-wide failure has recovered.
      this.indexFailures = 0;
      this.indexRetryAt = 0;
      const failure = this.failures.get(candidate);
      if (!failure || failure.retryAt <= now) return candidate;
    }
    return null;
  }

  private reportFailure(
    conversationId: string | null,
    stage: JournalMaintenanceErrorStage,
    error: unknown,
  ): void {
    if (!conversationId) this.indexFailures += 1;
    const code = error instanceof Error ? error.message : String(error);
    const known = conversationId ? this.failures.get(conversationId) : undefined;
    const previous = known?.code === code ? known : undefined;
    const attempts = (previous?.attempts ?? 0) + 1;
    const sinceReport = (previous?.suppressed ?? 0) + 1;
    const every = this.deps.errorReportEvery ?? DEFAULTS.errorReportEvery;
    const reported = attempts === 1 || sinceReport >= every;
    const base = this.deps.errorBackoffBaseMs ?? DEFAULTS.errorBackoffBaseMs;
    const max = this.deps.errorBackoffMaxMs ?? DEFAULTS.errorBackoffMaxMs;
    if (conversationId) {
      this.failures.set(conversationId, {
        code,
        attempts,
        suppressed: reported ? 0 : sinceReport,
        retryAt: Date.now() + Math.min(max, base * 2 ** Math.min(attempts - 1, 20)),
      });
    }
    if (!conversationId) {
      const indexBackoff = Math.min(max, base * 2 ** Math.min(this.indexFailures - 1, 20));
      this.indexRetryAt = Date.now() + indexBackoff;
    }
    this.deps.onError(error, {
      accountId: this.deps.accountId,
      conversationId,
      stage,
      attempts,
      suppressed: reported ? Math.max(0, sinceReport - 1) : 0,
      outcome: reported ? 'reported' : 'suppressed',
    });
  }

  private reportRecovered(conversationId: string): void {
    const failure = this.failures.get(conversationId);
    if (!failure) return;
    this.failures.delete(conversationId);
    this.deps.onRecovered?.({
      accountId: this.deps.accountId,
      conversationId,
      failedAttempts: failure.attempts,
      suppressed: failure.suppressed,
    });
  }
}

function normalizePass(value: JournalMaintenancePass | boolean): JournalMaintenancePass {
  return typeof value === 'boolean' ? { done: value, didWork: !value } : value;
}
