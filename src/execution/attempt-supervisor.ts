import type { KernelDecision, KernelEvent } from '../kernel/control-kernel.js';
import type {
  KernelDispatchItemRecord,
  KernelDispatchItemRepo,
} from '../storage/kernel-dispatch-item-repo.js';

type AttemptSupervisorRepository = Pick<
  KernelDispatchItemRepo,
  | 'insertBatch'
  | 'reconcileLaunching'
  | 'listPending'
  | 'claimPending'
  | 'markRunning'
  | 'markTerminal'
  | 'markUncertain'
>;

export interface AttemptSupervisorContext {
  run(item: KernelDispatchItemRecord): Promise<KernelEvent>;
  submit(event: KernelEvent): Promise<unknown>;
  onLaunchError(item: KernelDispatchItemRecord, error: unknown): Promise<KernelEvent>;
}

/**
 * Owns the asynchronous lifecycle of durable dispatch items. Kernel decisions
 * enqueue work; this supervisor only performs idempotent launch side effects.
 */
export class AttemptSupervisor {
  private readonly active = new Map<string, { taskId: string; promise: Promise<void> }>();
  private readonly contexts = new Map<string, AttemptSupervisorContext>();

  constructor(
    private readonly repository: AttemptSupervisorRepository,
    private readonly maxConcurrentAttempts: number,
  ) {
    if (!Number.isInteger(maxConcurrentAttempts) || maxConcurrentAttempts <= 0) {
      throw new Error('maxConcurrentAttempts must be a positive integer');
    }
  }

  enqueue(
    decision: KernelDecision & {
      action: Extract<KernelDecision['action'], { type: 'dispatch_batch' }>;
    },
    generationId: string,
    context: AttemptSupervisorContext,
    now: string,
  ): void {
    this.repository.insertBatch(decision, generationId, now);
    this.contexts.set(decision.action.taskId, context);
    this.kick(decision.action.taskId);
  }

  recover(taskId: string, context: AttemptSupervisorContext): void {
    this.repository.reconcileLaunching();
    this.contexts.set(taskId, context);
    this.kick(taskId);
  }

  activeCount(taskId?: string): number {
    if (!taskId) return this.active.size;
    return [...this.active.values()].filter(item => item.taskId === taskId).length;
  }

  async drain(taskId: string): Promise<void> {
    for (;;) {
      this.kick(taskId);
      const active = [...this.active.values()]
        .filter(item => item.taskId === taskId)
        .map(item => item.promise);
      if (active.length === 0 && this.repository.listPending(taskId).length === 0) return;
      if (active.length === 0) {
        await Promise.resolve();
        continue;
      }
      await Promise.allSettled(active);
    }
  }

  private kick(taskId: string): void {
    const context = this.contexts.get(taskId);
    if (!context) return;
    const slots = this.maxConcurrentAttempts - this.active.size;
    if (slots <= 0) return;
    for (const pending of this.repository.listPending(taskId).slice(0, slots)) {
      if (this.active.has(pending.attemptId)) continue;
      const claimed = this.repository.claimPending(pending.attemptId, new Date().toISOString());
      if (!claimed) continue;
      const promise = this.launch(claimed, context)
        .finally(() => {
          this.active.delete(claimed.attemptId);
          this.kick(taskId);
        });
      this.active.set(claimed.attemptId, { taskId, promise });
    }
  }

  private async launch(
    item: KernelDispatchItemRecord,
    context: AttemptSupervisorContext,
  ): Promise<void> {
    if (!this.repository.markRunning(item.attemptId, null, new Date().toISOString())) {
      return;
    }
    try {
      const event = await context.run(item);
      this.repository.markTerminal(item.attemptId, null, new Date().toISOString());
      await context.submit(event);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      this.repository.markUncertain(item.attemptId, summary, new Date().toISOString());
      const event = await context.onLaunchError(item, error);
      await context.submit(event);
    }
  }
}
