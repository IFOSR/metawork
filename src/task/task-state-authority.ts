/**
 * Task state authority (2026-10-22 Task state simplification §1, §3.3).
 *
 * One place turns durable facts into the Task conclusion:
 *
 *   durable facts -> readTaskEvaluationInput() -> evaluateTaskState()
 *                 -> TaskLifecyclePort.applyTaskChange()
 *
 * Runtime call sites report that an operation finished (or that facts changed)
 * and ask this authority to reconcile. They never pick a Task status
 * themselves, which is what makes every surface show the same conclusion.
 */

import type { Task } from '../core/types.js';
import {
  allowedTaskStatusTransitions,
  createTaskReason,
  isTerminalTaskStatus,
  evaluateTaskState,
  type TaskStateDetail,
  type TaskStatus,
} from './task-state.js';
import {
  readTaskEvaluationInput,
  type TaskStateRawFacts,
  type TaskStateFactsPort,
} from './task-state-facts.js';
import type {
  TaskLifecyclePort,
  TaskStateApplyResult,
  TaskStateTransactionPort,
  TaskTransitionActor,
} from './task-lifecycle-transition-port.js';

export type { TaskStateFactsPort } from './task-state-facts.js';

export interface TaskStateAuthorityDeps {
  readonly facts: TaskStateFactsPort;
  readonly taskRepo: Pick<import('../storage/task-repo.js').TaskRepo, 'findById'>;
  readonly lifecycle: Pick<TaskLifecyclePort, 'applyTaskChange'>;
  readonly transaction: TaskStateTransactionPort;
  readonly stateChanges?: Pick<import('../storage/task-state-change-repo.js').TaskStateChangeRepo, 'findByOperationKey'>;
  /** Bounded post-commit observation for diagnostics and in-process refresh. */
  onChanged?(task: Task, previousStatus: TaskStatus): void;
  /**
   * Post-commit hook for a Task that just stopped to wait for the user. The
   * Conversation slot must be released once its operations are safely stopped,
   * so a later answer is never queued behind a waiting Task. Implementations
   * re-check durable residue before releasing and are safe to call repeatedly.
   */
  onWaitingForUser?(task: Task): void;
  now?(): string;
}

export interface ReconcileTaskStateInput {
  readonly taskId: string;
  /** Kernel Decision identity, or a deterministic Task Domain operation identity. */
  readonly decisionId: string;
  /** Deterministic idempotency key of the operation that changed the facts. */
  readonly operationKey: string;
  readonly actor: TaskTransitionActor;
  readonly reason: string;
  readonly evidenceRefs?: readonly string[];
  /**
   * Local domain facts that must commit with the state change, e.g. resolving
   * exactly one accepted item. Runs inside the transaction and returns refs.
   */
  readonly facts?: () => readonly string[];
  /**
   * The exact pending result this operation resolves. The pending projection
   * still lists it until the state change is committed, so the evaluation must
   * treat it as resolved for this one submission.
   */
  readonly resumeAuthorized?: boolean;
  readonly resolvedResult?: { readonly attemptId: string; readonly resultId: string };
}

export interface TaskStateReconciliation {
  readonly task: Task;
  readonly detail: TaskStateDetail;
  readonly applied: boolean;
  readonly result: TaskStateApplyResult | null;
}

export class TaskStateAuthority {
  private readonly now: () => string;

  constructor(private readonly deps: TaskStateAuthorityDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Recomputes the Task conclusion from facts and applies it when it changed.
   * Idempotent: the same `operationKey` with the same payload is a no-op.
   */
  reconcile(input: ReconcileTaskStateInput): TaskStateReconciliation | null {
    const outcome = this.deps.transaction.run(() => {
      const previous = this.deps.stateChanges?.findByOperationKey(input.taskId, input.operationKey);
      if (previous) {
        if (previous.decisionId !== input.decisionId) {
          throw new Error(`Task operation identity conflict: ${input.operationKey}`);
        }
        const task = this.deps.taskRepo.findById(input.taskId);
        return task ? { task, detail: task.stateDetail, applied: false, result: null,
          previousStatus: task.status } : null;
      }
      // The fact mutation and the conclusion use one database snapshot.
      const factRefs = input.facts?.() ?? [];
      const raw = this.deps.facts.read(input.taskId);
      if (!raw) return null;
      const evaluationInput = readTaskEvaluationInput(
        input.resolvedResult && raw.pendingResult
          && raw.pendingResult.attemptId === input.resolvedResult.attemptId
          && raw.pendingResult.resultId === input.resolvedResult.resultId
          ? { ...raw, pendingResult: null, pendingResults: raw.pendingResults?.filter(result =>
              result.attemptId !== input.resolvedResult!.attemptId || result.resultId !== input.resolvedResult!.resultId) }
          : raw,
      );
      let evaluation = evaluateTaskState({
        taskId: raw.task.id,
        currentStatus: raw.task.status,
        cancelFence: raw.cancelFence,
        requiredWork: evaluationInput.requiredWork,
        pendingActions: evaluationInput.pendingActions,
        runnableWork: evaluationInput.runnableWork,
        activeOperation: evaluationInput.activeOperation,
        boundedRecovery: evaluationInput.boundedRecovery,
        slot: evaluationInput.slot,
        capacityWaiting: evaluationInput.capacityWaiting,
        cleanup: evaluationInput.cleanup,
        failureReason: evaluationInput.failureReason,
        anomaly: evaluationInput.anomaly,
        observedAt: this.now(),
      });
      if (isTerminalTaskStatus(raw.task.status)) {
        evaluation = { ...evaluation, detail: { ...evaluation.detail,
          reason: raw.task.stateDetail.reason } };
      }
      // A passive observation cannot authorize leaving a user pause. An exact
      // result decision may enqueue it, but cannot synthesize a running step.
      // The one exception is a block the *system* caused and durable facts now
      // disprove: every required item is complete and nothing waits for the
      // user, so the stale block is corrected to its proven conclusion instead
      // of asking the user to resume work that is already done
      // (ADR-0049 2026-10-28 amendment).
      // The guard is the fact, not the previous reason: all required work is
      // proven complete and nothing waits for the user. A stale block (a system
      // anomaly, or an input request that only existed to unblock work) must not
      // outlive its cause.
      const provenCompletion = raw.task.status === 'needs_action'
        && evaluation.status === 'succeeded'
        && evaluation.detail.pendingActions.length === 0;
      if (raw.task.status === 'needs_action' && evaluation.status !== 'cancelled'
        && !provenCompletion) {
        evaluation = (input.resumeAuthorized || (input.resolvedResult && evaluation.detail.pendingActions.length === 0))
          ? { status: 'queued', detail: { ...evaluation.detail, phase: null,
              reason: createTaskReason('waiting_for_capacity', '等待执行名额。') } }
          : { status: 'needs_action', detail: { ...evaluation.detail, phase: null,
              reason: evaluation.status === 'needs_action' ? evaluation.detail.reason : raw.task.stateDetail.reason } };
      }
      if (evaluation.status !== raw.task.status
        && !provenCompletion
        && !allowedTaskStatusTransitions(raw.task.status).includes(evaluation.status)) {
        evaluation = { status: raw.task.status, detail: raw.task.stateDetail };
      }
      const unchanged = evaluation.status === raw.task.status
        && JSON.stringify(evaluation.detail) === JSON.stringify(raw.task.stateDetail);
      if (unchanged && !input.facts && !input.resolvedResult) {
        return { task: raw.task, detail: raw.task.stateDetail, applied: false,
          result: null, previousStatus: raw.task.status };
      }
      const result = this.deps.lifecycle.applyTaskChange({
        taskId: raw.task.id,
        decisionId: input.decisionId,
        operationKey: input.operationKey,
        expectedVersion: raw.task.stateVersion,
        generationId: raw.activeGraph?.generationId ?? null,
        graphRevision: raw.activeGraph?.revision ?? null,
        to: evaluation.status,
        detail: evaluation.detail,
        actor: input.actor,
        reason: input.reason,
        evidenceRefs: [...(input.evidenceRefs ?? []), ...factRefs],
      });
      if (!result) return null;
      return {
        task: result.task,
        detail: evaluation.detail,
        applied: result.applied,
        result,
        previousStatus: raw.task.status,
      };
    });
    if (!outcome) return null;
    // Observation and pause-release run after the state transaction committed.
    // Both are best-effort: the durable rows already record the conclusion.
    if (outcome.applied) {
      try {
        this.deps.onChanged?.(outcome.task, outcome.previousStatus);
      } catch {
        // Observation only.
      }
      // Only a real pause releases the slot. A Task that was already waiting and
      // is merely re-summarised (for example at the start of an explicit resume)
      // must keep the slot the resume just claimed.
      if (outcome.task.status === 'needs_action' && outcome.previousStatus !== 'needs_action') {
        try {
          this.deps.onWaitingForUser?.(outcome.task);
        } catch {
          // The periodic convergence repeats this release from durable facts.
        }
      }
    }
    return {
      task: outcome.task,
      detail: outcome.detail,
      applied: outcome.applied,
      result: outcome.result,
    };
  }

  /** Current facts for one Task, for diagnostics and projections. */
  readFacts(taskId: string): TaskStateRawFacts | null {
    return this.deps.facts.read(taskId);
  }
}
