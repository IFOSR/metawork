import { Worker } from 'node:worker_threads';

/** One request in flight per account; callers await maintenance, never enqueue an audit. */
export class ConversationHistoryWorkerClient {
  private worker: Worker | null = null;
  private pending: { resolve(progressed: boolean): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private closed = false;

  constructor(private readonly url: URL, private readonly database: string, private readonly accountId: string) {}

  run(conversationId: string, epoch?: string): Promise<boolean> {
    if (this.closed) return Promise.reject(new Error('history_worker_closed'));
    if (this.pending) return Promise.reject(new Error('history_worker_busy'));
    if (!this.worker) {
      const worker = new Worker(this.url, { workerData: { database: this.database, accountId: this.accountId },
        resourceLimits: { maxOldGenerationSizeMb: 128 } });
      this.worker = worker;
      worker.on('message', (result: { progressed: boolean; error?: string }) => {
        if (this.worker !== worker) return;
        const pending = this.pending;
        if (!pending) return;
        clearTimeout(pending.timer); this.pending = null;
        if (result.error) pending.reject(new Error(result.error));
        else pending.resolve(result.progressed);
      });
      const failed = (error: Error) => {
        if (this.worker !== worker) return;
        this.worker = null;
        if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
      };
      worker.on('error', failed);
      worker.on('exit', code => failed(new Error(`history_worker_exit_${code}`)));
      worker.unref();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const worker = this.worker; this.worker = null; this.pending = null;
        void worker?.terminate(); reject(new Error('history_worker_timeout'));
      }, 10_000);
      timer.unref();
      this.pending = { resolve, reject, timer };
      this.worker!.postMessage({ conversationId, epoch });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('history_worker_closed')); this.pending = null; }
    const worker = this.worker; this.worker = null;
    await worker?.terminate();
  }
}
