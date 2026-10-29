/**
 * The single durable Task state entry (2026-10-22 Task state simplification §4).
 *
 * Every Task lifecycle write goes through `applyTaskChange()`. It is the only
 * code allowed to write `tasks.status`, `tasks.state_version`,
 * `tasks.state_detail_json` and `tasks.completed_at`. In one database
 * transaction it:
 *
 *   1. resolves the operation key (same key + same payload is a replay);
 *   2. validates the Decision identity, Task version, active graph and cancel
 *      fence against the facts it re-reads;
 *   3. applies the narrowly scoped local domain facts the command names;
 *   4. conditionally writes the Task state and the durable state change row;
 *   5. appends the durable projection notification.
 *
 * Kernel `markApplied()` and this write are committed together by the workflow's
 * atomic application seam, so a crash can never leave one without the other.
 *
 * The port is a Task Domain interface. Its SQLite adapter lives in
 * `src/storage/`, so the domain never imports a concrete repository.
 *
 * Subtask node transitions keep their own port: Subtask run state is a Work
 * Graph/Task Domain node fact, not the Task conclusion.
 */

import type {
  Subtask,
  Task,
  TaskStatus,
  SubtaskStatus,
} from '../core/types.js';
import {
  isTaskStatusTransitionAllowed,
  isTerminalTaskStatus,
  normalizeTaskStateDetail,
  type TaskStateDetail,
} from './task-state.js';
import {
  isSubtaskTransitionAllowed,
  isTerminalSubtaskLifecycle,
  toSubtaskLifecycleState,
  type SubtaskLifecycleState,
} from './task-lifecycle.js';

/**
 * Which layer asked for the change. Recorded on every state change so a
 * contradictory conclusion can be attributed to one owner.
 */
export type TaskTransitionActor =
  | 'kernel-execution-runtime'
  | 'task-cancellation-coordinator'
  | 'work-graph-runtime-service'
  | 'workspace-publication-worker'
  | 'subtask-attempt-runner'
  | 'session-kernel-runtime'
  | 'account-startup-recovery'
  | 'task-domain';

/** Durable Task state change, as recorded in `task_state_changes`. */
export interface TaskLifecycleTransitionRecord {
  readonly kind: 'task' | 'subtask';
  readonly id: string;
  readonly from: TaskStatus | SubtaskLifecycleState;
  readonly to: TaskStatus | SubtaskLifecycleState;
  readonly actor: TaskTransitionActor;
  readonly reason: string;
  readonly at: string;
}

export interface InvalidLifecycleTransitionError extends Error {
  readonly code: 'invalid_task_transition' | 'invalid_subtask_transition';
  readonly taskId?: string;
  readonly subtaskId?: string;
  readonly from: string;
  readonly to: string;
  readonly actor: TaskTransitionActor;
  readonly reason: string;
}

export interface StaleTaskStateError extends Error {
  readonly code: 'stale_task_state';
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
}

export interface TaskOperationConflictError extends Error {
  readonly code: 'task_operation_conflict';
  readonly taskId: string;
  readonly operationKey: string;
}

export interface ApplyTaskChangeCommand {
  readonly taskId: string;
  /** Kernel Decision identity, or a deterministic identity for Task Domain work. */
  readonly decisionId: string;
  /** Deterministic idempotency key of the operation being applied. */
  readonly operationKey: string;
  /** The Task state version the caller validated against. */
  readonly expectedVersion: number;
  readonly generationId: string | null;
  readonly graphRevision: number | null;
  readonly to: TaskStatus;
  readonly detail: TaskStateDetail;
  readonly actor: TaskTransitionActor;
  readonly reason: string;
  readonly evidenceRefs?: readonly string[];
  /**
   * Narrowly scoped local domain facts that must commit with this state change,
   * such as resolving exactly the listed pending items. Returns evidence refs.
   * It must never resolve every dependency or start an external action.
   */
  readonly facts?: () => readonly string[];
}

export interface TaskStateApplyResult {
  readonly task: Task;
  /** False when the operation key was already applied with the same payload. */
  readonly applied: boolean;
  readonly record: TaskLifecycleTransitionRecord;
}

export interface TaskStateTransactionPort {
  /** Runs the callback in one database transaction (immediate, no nesting escape). */
  run<T>(operation: () => T): T;
}

export interface TaskLifecycleStorePort {
  findTask(taskId: string): Task | null;
  findChangeByOperationKey(taskId: string, operationKey: string):
    {
      readonly version: number;
      readonly decisionId: string;
      readonly toStatus: TaskStatus;
      readonly detail: TaskStateDetail;
      readonly createdAt: string;
    } | null;
  applyTaskState(input: {
    taskId: string;
    expectedVersion: number;
    from: TaskStatus;
    to: TaskStatus;
    detail: TaskStateDetail;
    completedAt: string | null;
    at: string;
  }): Task | null;
  appendChange(record: {
    taskId: string;
    version: number;
    operationKey: string;
    decisionId: string;
    fromStatus: TaskStatus;
    toStatus: TaskStatus;
    detail: TaskStateDetail;
    evidenceRefs: readonly string[];
    createdAt: string;
  }): void;
  appendProjection(input: {
    taskId: string;
    accountId: string;
    conversationId: string;
    stateVersion: number;
    status: TaskStatus;
    detail: TaskStateDetail;
    createdAt: string;
  }): void;
  activeGraph(taskId: string): { readonly generationId: string; readonly revision: number } | null;
  listChanges(taskId: string, limit?: number): readonly {
    readonly version: number;
    readonly operationKey: string;
    readonly decisionId: string;
    readonly fromStatus: TaskStatus;
    readonly toStatus: TaskStatus;
    readonly detail: TaskStateDetail;
    readonly createdAt: string;
  }[];
}

export interface TaskLifecyclePort {
  applyTaskChange(command: ApplyTaskChangeCommand): TaskStateApplyResult;
  /** Durable state change history. Not an in-process observation buffer. */
  listTransitions(taskId: string, limit?: number): readonly TaskLifecycleTransitionRecord[];
}

export interface TaskLifecyclePortDeps {
  readonly store: TaskLifecycleStorePort;
  readonly transaction: TaskStateTransactionPort;
  /** In-process notification after commit. Delivery failures never roll back state. */
  onApplied?(record: TaskLifecycleTransitionRecord): void;
  now?(): string;
}

export interface TransitionSubtaskInput {
  subtaskId: string;
  to: SubtaskStatus;
  actor: TaskTransitionActor;
  reason: string;
  changes?: Parameters<import('../storage/subtask-repo.js').SubtaskRepo['updateStatus']>[2];
}

/** Task Domain Subtask node lifecycle port. */
export interface SubtaskLifecyclePort {
  transitionSubtask(input: TransitionSubtaskInput): Subtask;
  listTransitions(): readonly TaskLifecycleTransitionRecord[];
}

export interface SubtractLifecyclePortDeps {
  subtaskRepo: Pick<import('../storage/subtask-repo.js').SubtaskRepo, 'findById' | 'updateStatus'>;
  onTransition?(record: TaskLifecycleTransitionRecord): void;
  now?(): string;
}

export type SubtractLifecyclePortDepsAlias = SubtractLifecyclePortDeps;

export function createTaskLifecyclePort(deps: TaskLifecyclePortDeps): TaskLifecyclePort {
  const now = deps.now ?? (() => new Date().toISOString());
  const notify = (record: TaskLifecycleTransitionRecord) => {
    try {
      deps.onApplied?.(record);
    } catch {
      // Projection notification is best-effort; the durable outbox row is the
      // source of truth for a retry.
    }
  };
  return {
    applyTaskChange: command => {
      const outcome = deps.transaction.run(() => applyInTransaction(deps, command, now()));
      notify(outcome.record);
      const task = deps.store.findTask(command.taskId);
      if (!task) throw new Error(`Task disappeared during state application: ${command.taskId}`);
      return { task, applied: outcome.applied, record: outcome.record };
    },
    listTransitions: (taskId, limit = 50) => deps.store.listChanges(taskId, limit).map(change => ({
      kind: 'task',
      id: taskId,
      from: change.fromStatus,
      to: change.toStatus,
      actor: 'task-domain',
      reason: change.operationKey,
      at: change.createdAt,
    })),
  };
}

function applyInTransaction(
  deps: TaskLifecyclePortDeps,
  command: ApplyTaskChangeCommand,
  at: string,
): { record: TaskLifecycleTransitionRecord; applied: boolean } {
  const detail = normalizeTaskStateDetail(command.detail);
  const existing = deps.store.findChangeByOperationKey(command.taskId, command.operationKey);
  if (existing) {
    const samePayload = existing.decisionId === command.decisionId
      && existing.toStatus === command.to
      && JSON.stringify(existing.detail) === JSON.stringify(detail);
    if (samePayload) {
      return {
        applied: false,
        record: {
          kind: 'task',
          id: command.taskId,
          from: existing.toStatus,
          to: existing.toStatus,
          actor: command.actor,
          reason: command.reason,
          at: existing.createdAt,
        },
      };
    }
    throw operationConflict(command.taskId, command.operationKey);
  }

  const task = deps.store.findTask(command.taskId);
  if (!task) throw new Error(`Task Domain transition target does not exist: ${command.taskId}`);
  if (task.stateVersion !== command.expectedVersion) {
    throw staleState(task.id, command.expectedVersion, task.stateVersion);
  }
  if (!isTaskStatusTransitionAllowed(task.status, command.to)) {
    // A `needs_action` block that the system itself caused may be corrected to
    // success when the facts now prove every required item complete and no user
    // action is pending. This is a fact correction, not an override: a block
    // that asks the user for something (accept/retry/input) has pending
    // actions, and a Task with unfinished work never evaluates to `succeeded`
    // (ADR-0049 2026-10-28 amendment).
    if (!isProvenSystemBlockCorrection(task, command)) {
      throw lifecycleError({
        code: 'invalid_task_transition',
        taskId: task.id,
        from: task.status,
        to: command.to,
        actor: command.actor,
        reason: command.reason,
      });
    }
  }
  // A committed cancellation fence rejects every later business conclusion.
  if (task.status === 'cancelled' && command.to !== 'cancelled') {
    throw operationConflict(task.id, command.operationKey);
  }
  if (command.generationId !== null && command.graphRevision !== null) {
    const active = deps.store.activeGraph(task.id);
    if (!active || active.generationId !== command.generationId || active.revision !== command.graphRevision) {
      throw staleState(task.id, command.expectedVersion, task.stateVersion);
    }
  }

  const factRefs = command.facts ? [...command.facts()] : [];
  const completedAt = isTerminalTaskStatus(command.to)
    ? (task.completedAt ?? at)
    : null;
  const updated = deps.store.applyTaskState({
    taskId: task.id,
    expectedVersion: command.expectedVersion,
    from: task.status,
    to: command.to,
    detail,
    completedAt,
    at,
  });
  if (!updated) throw staleState(task.id, command.expectedVersion, task.stateVersion);

  deps.store.appendChange({
    taskId: task.id,
    version: updated.stateVersion,
    operationKey: command.operationKey,
    decisionId: command.decisionId,
    fromStatus: task.status,
    toStatus: command.to,
    detail,
    evidenceRefs: [...(command.evidenceRefs ?? []), ...factRefs],
    createdAt: at,
  });
  deps.store.appendProjection({
    taskId: task.id,
    accountId: task.accountId ?? 'legacy-account',
    conversationId: task.conversationId ?? 'legacy-conversation',
    stateVersion: updated.stateVersion,
    status: command.to,
    detail,
    createdAt: at,
  });
  return {
    applied: true,
    record: {
      kind: 'task',
      id: task.id,
      from: task.status,
      to: command.to,
      actor: command.actor,
      reason: command.reason,
      at,
    },
  };
}

export function createSubtaskLifecyclePort(deps: SubtractLifecyclePortDeps): SubtaskLifecyclePort {
  const now = deps.now ?? (() => new Date().toISOString());
  const transitions: TaskLifecycleTransitionRecord[] = [];
  return {
    transitionSubtask: input => {
      const subtask = deps.subtaskRepo.findById(input.subtaskId);
      if (!subtask) {
        throw new Error(`Work Graph transition target does not exist: ${input.subtaskId}`);
      }
      const from = toSubtaskLifecycleState(subtask.status);
      const target = toSubtaskLifecycleState(input.to);
      if (isTerminalSubtaskLifecycle(from) && from === target) {
        return subtask;
      }
      if (!isSubtaskTransitionAllowed(from, target)) {
        throw lifecycleError({
          code: 'invalid_subtask_transition',
          subtaskId: input.subtaskId,
          from,
          to: target,
          actor: input.actor,
          reason: input.reason,
        });
      }
      deps.subtaskRepo.updateStatus(input.subtaskId, input.to, input.changes);
      const updated = deps.subtaskRepo.findById(input.subtaskId) ?? subtask;
      const entry: TaskLifecycleTransitionRecord = {
        kind: 'subtask',
        id: input.subtaskId,
        from,
        to: target,
        actor: input.actor,
        reason: input.reason,
        at: now(),
      };
      transitions.push(entry);
      deps.onTransition?.(entry);
      return updated;
    },
    listTransitions: () => [...transitions],
  };
}

/** Convenience composition for callers that own both ports. */
export interface TaskLifecycleTransitionPort extends TaskLifecyclePort {
  transitionSubtask(input: TransitionSubtaskInput): Subtask;
  /** In-process Subtask observation stream. Task history is durable. */
  listSubtaskTransitions(): readonly TaskLifecycleTransitionRecord[];
}

export function createTaskLifecycleTransitionPort(deps: {
  store: TaskLifecycleStorePort;
  transaction: TaskStateTransactionPort;
  subtaskRepo: SubtractLifecyclePortDeps['subtaskRepo'];
  onApplied?(record: TaskLifecycleTransitionRecord): void;
  now?(): string;
}): TaskLifecycleTransitionPort {
  const tasks = createTaskLifecyclePort(deps);
  const subtasks = createSubtaskLifecyclePort({
    subtaskRepo: deps.subtaskRepo,
    ...(deps.onApplied ? { onTransition: deps.onApplied } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  return {
    ...tasks,
    transitionSubtask: subtasks.transitionSubtask,
    listSubtaskTransitions: subtasks.listTransitions,
  };
}

/**
 * Facts a caller may pass to describe the canonical lifecycle of a Task it is
 * about to transition. Retained so diagnostics log the same conclusion the
 * projection reports.
 */
export function describeTaskLifecycle(input: { task: Task }): TaskStatus {
  return input.task.status;
}


function staleState(taskId: string, expectedVersion: number, actualVersion: number): StaleTaskStateError {
  const error = new Error(
    `Task #${taskId} state version moved from ${expectedVersion} to ${actualVersion}`,
  ) as StaleTaskStateError;
  return Object.assign(error, {
    name: 'StaleTaskStateError',
    code: 'stale_task_state' as const,
    taskId,
    expectedVersion,
    actualVersion,
  });
}

function operationConflict(taskId: string, operationKey: string): TaskOperationConflictError {
  const error = new Error(
    `Task #${taskId} already applied a different payload for operation ${operationKey}`,
  ) as TaskOperationConflictError;
  return Object.assign(error, {
    name: 'TaskOperationConflictError',
    code: 'task_operation_conflict' as const,
    taskId,
    operationKey,
  });
}

/**
 * `needs_action -> succeeded` is allowed only as the correction of a stale block
 * whose required work is now proven complete and where nothing waits for the
 * user (the new detail carries no pending action). The authority only proposes
 * this target after evaluating durable facts; a block that asks the user to
 * accept, retry or provide input still has a pending action and is refused.
 */
function isProvenSystemBlockCorrection(
  task: Task,
  command: ApplyTaskChangeCommand,
): boolean {
  if (task.status !== 'needs_action' || command.to !== 'succeeded') return false;
  // The facts already proved every required item complete (the authority only
  // proposes this target after evaluating them) and nothing waits for the user.
  return command.detail.pendingActions.length === 0;
}

function lifecycleError(input: {
  code: 'invalid_task_transition' | 'invalid_subtask_transition';
  taskId?: string;
  subtaskId?: string;
  from: string;
  to: string;
  actor: TaskTransitionActor;
  reason: string;
}): InvalidLifecycleTransitionError {
  const target = input.taskId
    ? `Task #${input.taskId}`
    : `Subtask #${input.subtaskId}`;
  const error = new Error(
    `${target} rejected cross-layer lifecycle transition ${input.from} -> ${input.to} `
    + `(actor=${input.actor}, reason=${input.reason})`,
  ) as InvalidLifecycleTransitionError;
  return Object.assign(error, {
    name: 'InvalidLifecycleTransitionError',
    code: input.code,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.subtaskId ? { subtaskId: input.subtaskId } : {}),
    from: input.from,
    to: input.to,
    actor: input.actor,
    reason: input.reason,
  });
}
