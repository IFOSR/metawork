interface JournalMaintenanceDeps {
  readonly accountId: string;
  readonly nextStream: (accountId: string, afterConversationId: string) => string | null;
  /** False means the bounded directory scan needs another pass on this stream. */
  readonly maintain: (accountId: string, conversationId: string) => Promise<boolean>;
  readonly onError: (error: unknown) => void;
  readonly intervalMs?: number;
}

/** Background read-model maintenance, never a navigation or lifecycle owner. */
export class EventJournalMaintenance {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private running = false;
  private cursor = '';
  private current: string | null = null;
  private consecutiveBatches = 0;

  constructor(private readonly deps: JournalMaintenanceDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.pending;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = this.runOnce().finally(() => {
        this.pending = null;
        this.schedule();
      });
    }, this.deps.intervalMs ?? 1_000);
    this.timer.unref();
  }

  private async runOnce(): Promise<void> {
    try {
      this.current ??= this.deps.nextStream(this.deps.accountId, this.cursor);
      if (!this.current) {
        this.cursor = '';
        return;
      }
      if (await this.deps.maintain(this.deps.accountId, this.current) || ++this.consecutiveBatches >= 4) {
        this.cursor = this.current;
        this.current = null;
        this.consecutiveBatches = 0;
      }
    } catch (error) {
      // One damaged stream must not starve every other stream.
      this.cursor = this.current ?? this.cursor;
      this.current = null;
      this.deps.onError(error);
    }
  }
}
