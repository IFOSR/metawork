/**
 * Task Runtime control workflow (ADR-0055 D6).
 *
 * The Runtime owns the loop: no event inbox, no decision ledger, no replay. An
 * event is decided from durable facts and applied immediately, in process,
 * serially; follow-up observations are decided in the same drain.
 *
 * Crash safety comes from owner facts, not a ledger: appliers are idempotent
 * against their own rows, and an interrupted application records one explicit
 * recovery item (`task_recovery_items`) that restart recovery inspects.
 */
import { allowsControlAction, type ProductionAuthorizationFact } from '../control/production-authorization.js';
import {
  ControlApplicationInterruptedError,
  ControlApplicationRejectionError,
  ControlApplicationSettledError,
  type ControlDecider,
  type ControlRecoveryReport,
  type ControlWorkflow,
  type ControlWorkflowResult,
} from '../control/control-workflow.js';
import type { ControlDecision, ControlEvent, ControlSnapshot } from '../control/control-contracts.js';

export interface UncertainControlOperation {
  readonly operation: ControlDecision;
  readonly taskId: string | null;
  readonly subtaskId: string | null;
  readonly attemptId: string | null;
  readonly error: unknown;
}

export interface TaskControlWorkflowDeps {
  productionAuthorization?: () => ProductionAuthorizationFact;
  kernel: ControlDecider;
  buildSnapshot(event: ControlEvent): ControlSnapshot;
  runtime: { apply(decision: ControlDecision): Promise<ControlEvent | null> };
  clock: { now(): string };
  acceptedEventTypes?: ControlEvent['type'][];
  acceptedActions?: ControlDecision['action']['type'][];
  taskId?: string;
  correlationId?: string;
  recordUncertain?(input: UncertainControlOperation): void;
  /** Release owner routing context after an event leaves the in-memory drain. */
  onEventSettled?(event: ControlEvent): void;
}

const MAX_OPERATIONS_PER_DRAIN = 100;
const MAX_REMEMBERED_EVENTS = 512;

export class TaskControlWorkflow implements ControlWorkflow {
  private queue: ControlEvent[] = [];
  private draining: Promise<ControlWorkflowResult> | null = null;
  private readonly remembered: string[] = [];
  private readonly eventStates = new Map<string, 'queued' | 'applying' | 'applied' | 'uncertain'>();

  constructor(private readonly deps: TaskControlWorkflowDeps) {}

  async submit(event: ControlEvent): Promise<ControlWorkflowResult> {
    this.assertAcceptedEvent(event);
    const state = this.eventStates.get(event.id);
    if (state === 'queued' || state === 'applying') return this.drainSerially();
    if (state) {
      // An interrupted operation may already have external effects. A repeated
      // request reports that uncertainty; only owner recovery may resolve it.
      return { decisions: [], quiescent: this.queue.length === 0 && !this.draining,
        pendingRecovery: this.pendingRecoveryCount() };
    }
    this.enqueue(event);
    return this.drainSerially();
  }

  async recover(): Promise<ControlRecoveryReport> {
    const result = await this.drainSerially();
    return {
      ...result,
      reconciledProcessingEvents: 0,
      applicationCounts: { pending: 0, applying: 0, applied: 0, uncertain: this.pendingRecoveryCount(), failed: 0 },
    };
  }

  private drainSerially(): Promise<ControlWorkflowResult> {
    if (this.draining) return this.draining;
    // Start after assigning the shared promise, including a synchronous/empty
    // drain. New submissions between drain completion and its continuation
    // must be drained before their shared promise resolves.
    this.draining = Promise.resolve().then(async () => {
      try {
        const decisions: ControlDecision[] = [];
        let result: ControlWorkflowResult;
        do {
          result = await this.drain();
          decisions.push(...result.decisions);
        } while (result.quiescent && this.queue.length > 0);
        return { ...result, decisions };
      } finally {
        this.draining = null;
      }
    });
    return this.draining;
  }

  private async drain(): Promise<ControlWorkflowResult> {
    const decisions: ControlDecision[] = [];
    let handled = 0;
    while (this.queue.length > 0) {
      if (handled >= MAX_OPERATIONS_PER_DRAIN) {
        throw new Error('Task control workflow did not reach quiescence');
      }
      const event = this.queue.shift()!;
      this.eventStates.set(event.id, 'applying');
      try {
        const authorization = this.deps.productionAuthorization?.();
        const snapshot: ControlSnapshot = {
          ...this.deps.buildSnapshot(event),
          ...(authorization ? { productionAuthorization: authorization } : {}),
        };
        const decision = this.deps.kernel.decide(event, snapshot);
        if (this.deps.acceptedActions && !this.deps.acceptedActions.includes(decision.action.type)) {
          this.forgetEvent(event.id);
          throw new ControlApplicationRejectionError(
            `control action is not accepted by this workflow: ${decision.action.type}`,
            'action_not_allowed',
          );
        }
        decisions.push(decision);
        handled += 1;
        if (!allowsControlAction(decision.action, snapshot.productionAuthorization)) {
          this.markApplied(event.id);
          continue;
        }
        try {
          const observation = await this.deps.runtime.apply(decision);
          this.markApplied(event.id);
          if (observation) this.enqueue(observation);
        } catch (error) {
          if (error instanceof ControlApplicationInterruptedError) {
            this.eventStates.set(event.id, 'uncertain');
            this.recordUncertain(decision, error, event.taskId ?? null);
            break;
          }
          const settled = error instanceof ControlApplicationRejectionError
            || error instanceof ControlApplicationSettledError;
          if (settled) this.markApplied(event.id);
          else {
            this.eventStates.set(event.id, 'uncertain');
            this.recordUncertain(decision, error, event.taskId ?? null);
          }
          break;
        }
      } catch (error) {
        // Snapshot/policy failures have not invoked the Runtime and may be
        // retried. Uncertain effects retain their fence even if journaling fails.
        if (this.eventStates.get(event.id) === 'applying') this.forgetEvent(event.id);
        throw error;
      } finally {
        this.deps.onEventSettled?.(event);
      }
    }
    return { decisions, quiescent: this.queue.length === 0, pendingRecovery: this.pendingRecoveryCount() };
  }

  private enqueue(event: ControlEvent): void {
    if (this.eventStates.has(event.id)) return;
    this.eventStates.set(event.id, 'queued');
    this.queue.push(event);
  }

  private markApplied(eventId: string): void {
    this.eventStates.set(eventId, 'applied');
    this.remembered.push(eventId);
    // Only settled events can leave the bounded dedup cache. Evicting queued,
    // applying or uncertain IDs could authorize duplicate external effects.
    if (this.remembered.length > MAX_REMEMBERED_EVENTS) {
      this.eventStates.delete(this.remembered.shift()!);
    }
  }

  private pendingRecoveryCount(): number {
    let count = 0;
    for (const state of this.eventStates.values()) if (state === 'uncertain') count += 1;
    return count;
  }

  private forgetEvent(eventId: string): void {
    this.eventStates.delete(eventId);
  }

  private assertAcceptedEvent(event: ControlEvent): void {
    if (this.deps.acceptedEventTypes && !this.deps.acceptedEventTypes.includes(event.type)) {
      throw new ControlApplicationRejectionError(
        `control event is not accepted by this workflow: ${event.type}`,
        'event_type_not_allowed',
      );
    }
  }

  private recordUncertain(decision: ControlDecision, error: unknown, eventTaskId: string | null): void {
    this.deps.recordUncertain?.({
      operation: decision,
      taskId: 'taskId' in decision.action ? decision.action.taskId : this.deps.taskId ?? eventTaskId,
      subtaskId: 'subtaskId' in decision.action ? decision.action.subtaskId ?? null : null,
      attemptId: decision.action.type === 'dispatch_batch' && decision.action.items.length === 1
        ? decision.action.items[0]!.attemptId
        : null,
      error,
    });
  }
}
