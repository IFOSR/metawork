import { allowsProduction, type ProductionAuthorizationFact } from '../control/production-authorization.js';
import type { ControlDecision, ControlEvent } from '../control/control-contracts.js';
import type {
  ControlDispatchItemRecord,
  ControlDispatchItemRepo,
} from '../storage/dispatch-item-repo.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import { ATTEMPTS_PER_TASK_BUDGET } from '../core/runtime-limits.js';

/** Attempts a single Task may run at once; internal budget, not a setting. */
export const DEFAULT_ATTEMPTS_PER_TASK = ATTEMPTS_PER_TASK_BUDGET;

type AttemptSupervisorRepository = Pick<
  ControlDispatchItemRepo,
  | 'insertBatch'
  | 'reconcileLaunching'
  | 'listPending'
  | 'claimPending'
  | 'markRunning'
  | 'markTerminal'
  | 'markNotStarted'
  | 'markUncertain'
>;

export interface AttemptSupervisorBindingContext {
  generationId: string;
  configurationRevision: string;
  executionBindingFingerprint?: string | null;
  attempts: Readonly<Record<string, {
    authorizedBinding: AuthorizedExecutorBinding;
    bindingFingerprint: string;
  }>>;
}

export interface AttemptSupervisorContext {
  run(item: ControlDispatchItemRecord): Promise<ControlEvent>;
  submit(event: ControlEvent): Promise<unknown>;
  onLaunchError(item: ControlDispatchItemRecord, error: unknown): Promise<ControlEvent>;
}

/**
 * Owns the asynchronous lifecycle of durable dispatch items. Kernel decisions
 * enqueue work; this supervisor only performs idempotent launch side effects.
 */
export class AttemptSupervisor {
  private readonly active = new Map<string, { taskId: string; promise: Promise<void> }>();
  private readonly contexts = new Map<string, AttemptSupervisorContext>();
  private readonly taskIds = new Set<string>();

  constructor(
    private readonly repository: AttemptSupervisorRepository,
    /**
     * Attempts one Task may run at once. There is deliberately no account-wide
     * Attempt ceiling: capacity is bounded per Workspace by the Conversation
     * scheduler, not by a global counter that starves a multi-subtask graph.
     */
    private readonly attemptsPerTask: number = DEFAULT_ATTEMPTS_PER_TASK,
    private readonly drainTuning: { idleSpinLimit?: number; spinDelayMs?: number } = {},
    private readonly productionAuthorization?: () => ProductionAuthorizationFact,
  ) {
    if (!Number.isInteger(attemptsPerTask) || attemptsPerTask <= 0) {
      throw new Error('attemptsPerTask must be a positive integer');
    }
  }

  enqueue(
    decision: ControlDecision & {
      action: Extract<ControlDecision['action'], { type: 'dispatch_batch' }>;
    },
    bindingContext: AttemptSupervisorBindingContext,
    context: AttemptSupervisorContext,
    now: string,
  ): void {
    this.repository.insertBatch(decision, bindingContext, now);
    this.taskIds.add(decision.action.taskId);
    for (const item of decision.action.items) {
      this.contexts.set(item.attemptId, context);
    }
    this.kickAll();
  }

  recover(taskId: string, context: AttemptSupervisorContext): void {
    this.repository.reconcileLaunching();
    this.taskIds.add(taskId);
    for (const item of this.repository.listPending(taskId)) {
      this.contexts.set(item.attemptId, context);
    }
    this.kickAll();
  }

  activeCount(taskId?: string): number {
    if (!taskId) return this.active.size;
    return [...this.active.values()].filter(item => item.taskId === taskId).length;
  }

  async drain(taskId: string): Promise<void> {
    // Bounded drain: pending items that can never be claimed (for example a
    // cancellation fence) must terminate the drain instead of spinning on
    // microtasks, which starves the event loop entirely (observed as a 100%
    // CPU busy loop that even blocked SIGTERM handling).
    const idleSpinLimit = this.drainTuning.idleSpinLimit ?? 600;
    const spinDelayMs = this.drainTuning.spinDelayMs ?? 100;
    let idleSpins = 0;
    for (;;) {
      this.kick(taskId);
      const active = [...this.active.values()]
        .filter(item => item.taskId === taskId)
        .map(item => item.promise);
      if (active.length === 0 && (!allowsProduction(this.productionAuthorization?.()) || this.repository.listPending(taskId).length === 0)) return;
      if (active.length === 0) {
        idleSpins += 1;
        if (idleSpins >= idleSpinLimit) {
          throw new Error(
            `attempt drain made no progress for task ${taskId}: `
            + `${this.repository.listPending(taskId).length} dispatch item(s) are not claimable`,
          );
        }
        // Yield to the macrotask queue so timers, IO, and signals keep running.
        await new Promise(resolve => setTimeout(resolve, spinDelayMs));
        continue;
      }
      idleSpins = 0;
      await Promise.allSettled(active);
    }
  }

  private kick(taskId: string): void {
    if (!allowsProduction(this.productionAuthorization?.())) return;
    const slots = this.attemptsPerTask - this.activeCount(taskId);
    if (slots <= 0) return;
    for (const pending of this.repository.listPending(taskId).slice(0, slots)) {
      if (this.active.has(pending.attemptId)) continue;
      const context = this.contexts.get(pending.attemptId);
      if (!context) continue;
      const claimed = this.repository.claimPending(pending.attemptId, new Date().toISOString());
      if (!claimed) continue;
      const promise = this.launch(claimed, context)
        .finally(() => {
          this.active.delete(claimed.attemptId);
          this.contexts.delete(claimed.attemptId);
          this.kickAll();
        });
      this.active.set(claimed.attemptId, { taskId, promise });
    }
  }

  private kickAll(): void {
    for (const taskId of this.taskIds) this.kick(taskId);
  }

  private async launch(
    item: ControlDispatchItemRecord,
    context: AttemptSupervisorContext,
  ): Promise<void> {
    if (!this.repository.markRunning(item.attemptId, null, new Date().toISOString())) {
      return;
    }
    try {
      const event = await context.run(item);
      // A dispatch item that stopped being active is not proof of success. An
      // Attempt only executed when its Runtime reported an execution fact; a
      // partition/capacity yield records `not_started` with no receipt, no
      // runtime and no measured duration, so surfaces cannot label it as
      // completed (2026-10-28 transparent execution §P2.1).
      if (isNonExecutionYield(event) || isNeverStartedOutcome(event)) {
        this.repository.markNotStarted(
          item.attemptId,
          isNeverStartedOutcome(event)
            ? event.failure?.summary ?? 'attempt failed before execution started'
            : `attempt yielded without execution: ${event.type}`,
          new Date().toISOString(),
        );
      } else {
        this.repository.markTerminal(item.attemptId, null, new Date().toISOString());
      }
      await context.submit(event);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      const event = await context.onLaunchError(item, error);
      if (isNeverStartedOutcome(event)) {
        this.repository.markNotStarted(item.attemptId, summary, new Date().toISOString());
      } else {
        this.repository.markUncertain(item.attemptId, summary, new Date().toISOString());
      }
      await context.submit(event);
    }
  }
}

/**
 * Events that mean "this Attempt did not execute": the Runtime yielded before
 * any Executor turn, receipt, progress or sandbox fact existed. They are Kernel
 * scheduling facts, never execution outcomes.
 */
function isNonExecutionYield(event: ControlEvent): boolean {
  return event.type === 'partition_conflict_observed'
    || event.type === 'capacity_signal';
}

/** A pre-launch failure has no execution duration or external effect. */
function isNeverStartedOutcome(event: ControlEvent): event is Extract<ControlEvent, { type: 'execution_outcome' }> {
  return event.type === 'execution_outcome'
    && event.failure?.attemptStarted === false
    && event.failure.externalSideEffect === false;
}
