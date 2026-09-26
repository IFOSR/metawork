/**
 * Central Task and Subtask lifecycle transition port
 * (2026-09-25 Task lifecycle state convergence plan §8 Phase 4).
 *
 * Every strategic Task or Subtask status write goes through this seam so there
 * is exactly one owner of a transition and it is validated against the canonical
 * lifecycle contract.
 *
 * ADR-0020 assigns the persisted Task/Subtask lifecycle and its transition
 * invariants to the **Task Domain**. Work Graph owns the proposal topology, node
 * identity, DAG derivation and frontier, and explicitly does *not* own Subtask
 * run state. Both ports therefore live in `src/task/`; a Work Graph consumer
 * asks `createSubtaskLifecyclePort()` for the node transition the Decision
 * requires instead of writing the repository.
 *
 * Runtime handlers apply one Kernel-authorized action and report one normalized
 * fact. They may ask this port for the transition that the Decision requires;
 * they may not choose a strategic state or write the repository directly.
 *
 * Non-strategic bookkeeping (priority, resources, snapshots, evidence) stays on
 * the regular Task/Work Graph services.
 *
 * `listTransitions()` is an in-process observation seam for diagnostics and
 * ownership tests. It is deliberately **not** a durable audit: the durable
 * record of a status change is the Kernel Decision, receipt and Task/Subtask row
 * that the transition produced.
 */

import type {
  Dependency,
  Subtask,
  Task,
  TaskSnapshot,
  TaskStatus,
  SubtaskStatus,
} from '../core/types.js';
import type { TaskRuntimeService } from './task-runtime-service.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import {
  deriveTaskLifecycleState,
  isSubtaskTransitionAllowed,
  isTaskTransitionAllowed,
  isTerminalSubtaskLifecycle,
  isTerminalTaskLifecycle,
  toSubtaskLifecycleState,
  toTaskLifecycleState,
  type SubtaskLifecycleState,
  type TaskLifecycleState,
} from './task-lifecycle.js';

/**
 * Which layer asked for the transition. Recorded on every transition so a
 * contradictory status can be traced to one owner instead of being attributed
 * to "the Runtime".
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

export interface TaskLifecycleTransitionRecord {
  readonly kind: 'task' | 'subtask';
  readonly id: string;
  readonly from: TaskLifecycleState | SubtaskLifecycleState;
  readonly to: TaskLifecycleState | SubtaskLifecycleState;
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

export interface TransitionTaskInput {
  taskId: string;
  to: TaskStatus;
  actor: TaskTransitionActor;
  reason: string;
}

export interface TransitionSubtaskInput {
  subtaskId: string;
  to: SubtaskStatus;
  actor: TaskTransitionActor;
  reason: string;
  changes?: Parameters<SubtaskRepo['updateStatus']>[2];
}

/** Task Domain lifecycle port. */
export interface TaskLifecyclePort {
  transitionTask(input: TransitionTaskInput): Task;
  cancelTask(input: { taskId: string; reason: string; actor: TaskTransitionActor }): Task;
  blockTask(input: {
    taskId: string;
    dependency: Omit<Dependency, 'createdAt'>;
    actor: TaskTransitionActor;
    reason: string;
  }): Task;
  parkTask(input: {
    taskId: string;
    reason: string;
    snapshot: Omit<TaskSnapshot, 'createdAt'>;
    actor: TaskTransitionActor;
  }): Task;
  unblockTask(input: { taskId: string; actor: TaskTransitionActor; reason: string }): Task;
  resumeParkedTask(input: { taskId: string; actor: TaskTransitionActor; reason: string }): Task;
  listTransitions(): readonly TaskLifecycleTransitionRecord[];
}

/** Task Domain Subtask node lifecycle port. */
export interface SubtaskLifecyclePort {
  transitionSubtask(input: TransitionSubtaskInput): Subtask;
  listTransitions(): readonly TaskLifecycleTransitionRecord[];
}

/** Convenience composition for callers that own both repositories. */
export interface TaskLifecycleTransitionPort extends TaskLifecyclePort, SubtaskLifecyclePort {}

export interface TaskLifecyclePortDeps {
  taskRuntimeService: Pick<
    TaskRuntimeService,
    | 'findTask'
    | 'transitionTask'
    | 'cancelTask'
    | 'blockTask'
    | 'parkTask'
    | 'unblockTask'
    | 'resumeParkedTask'
  >;
  /** In-process observation seam for diagnostics and focused ownership tests. */
  onTransition?(record: TaskLifecycleTransitionRecord): void;
  now?(): string;
}

export interface SubtaskLifecyclePortDeps {
  subtaskRepo: Pick<SubtaskRepo, 'findById' | 'updateStatus'>;
  /** In-process observation seam for diagnostics and focused ownership tests. */
  onTransition?(record: TaskLifecycleTransitionRecord): void;
  now?(): string;
}

export function createTaskLifecyclePort(deps: TaskLifecyclePortDeps): TaskLifecyclePort {
  const now = deps.now ?? (() => new Date().toISOString());
  const transitions: TaskLifecycleTransitionRecord[] = [];
  const record = (entry: TaskLifecycleTransitionRecord) => {
    transitions.push(entry);
    deps.onTransition?.(entry);
  };
  const requireTask = (taskId: string): Task => {
    const task = deps.taskRuntimeService.findTask(taskId);
    if (!task) throw new Error(`Task Domain transition target does not exist: ${taskId}`);
    return task;
  };
  /**
   * The canonical guard is evaluated against the persisted lifecycle, which the
   * TaskView projection refines with durable facts. A persisted `running` Task
   * without an active Attempt is reported `coordinating`, never `executing`.
   */
  const assertTransition = (
    task: Task,
    to: TaskStatus,
    actor: TaskTransitionActor,
    reason: string,
  ): { from: TaskLifecycleState; to: TaskLifecycleState } => {
    const from = toTaskLifecycleState(task.status);
    const target = toTaskLifecycleState(to);
    if (!isTaskTransitionAllowed(from, target)) {
      throw lifecycleError({
        code: 'invalid_task_transition',
        taskId: task.id,
        from,
        to: target,
        actor,
        reason,
      });
    }
    return { from, to: target };
  };
  const apply = (
    taskId: string,
    states: { from: TaskLifecycleState; to: TaskLifecycleState },
    actor: TaskTransitionActor,
    reason: string,
    mutate: () => Task,
  ): Task => {
    const updated = mutate();
    record({ kind: 'task', id: taskId, ...states, actor, reason, at: now() });
    return updated;
  };

  return {
    transitionTask: input => {
      const task = requireTask(input.taskId);
      const states = assertTransition(task, input.to, input.actor, input.reason);
      return apply(input.taskId, states, input.actor, input.reason, () => (
        deps.taskRuntimeService.transitionTask(input.taskId, input.to)
      ));
    },

    cancelTask: input => {
      const task = requireTask(input.taskId);
      if (isTerminalTaskLifecycle(toTaskLifecycleState(task.status))) {
        // Idempotent: replaying a durable cancellation is not an invalid
        // transition, and it must not fail the Kernel application.
        return task;
      }
      const states = assertTransition(task, 'cancelled', input.actor, input.reason);
      return apply(input.taskId, states, input.actor, input.reason, () => (
        deps.taskRuntimeService.cancelTask(input.taskId, input.reason)
      ));
    },

    blockTask: input => {
      const task = requireTask(input.taskId);
      if (toTaskLifecycleState(task.status) === 'blocked') {
        // Re-blocking an already blocked Task is a no-op, not a transition.
        return task;
      }
      const states = assertTransition(task, 'blocked', input.actor, input.reason);
      return apply(input.taskId, states, input.actor, input.reason, () => (
        deps.taskRuntimeService.blockTask(input.taskId, input.dependency)
      ));
    },

    parkTask: input => {
      const task = requireTask(input.taskId);
      const states = assertTransition(task, 'parked', input.actor, input.reason);
      return apply(input.taskId, states, input.actor, input.reason, () => (
        deps.taskRuntimeService.parkTask(input.taskId, input.reason, input.snapshot)
      ));
    },

    unblockTask: input => {
      const task = requireTask(input.taskId);
      const states = assertTransition(task, 'ready', input.actor, input.reason);
      return apply(input.taskId, states, input.actor, input.reason, () => (
        deps.taskRuntimeService.unblockTask(input.taskId)
      ));
    },

    resumeParkedTask: input => {
      const task = requireTask(input.taskId);
      const states = assertTransition(task, 'ready', input.actor, input.reason);
      return apply(input.taskId, states, input.actor, input.reason, () => (
        deps.taskRuntimeService.resumeParkedTask(input.taskId)
      ));
    },

    listTransitions: () => [...transitions],
  };
}

export function createSubtaskLifecyclePort(deps: SubtaskLifecyclePortDeps): SubtaskLifecyclePort {
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
      if (isTerminalSubtaskLifecycle(from) && from === target) {
        // Already terminal with the same state: nothing to write.
        return subtask;
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

/**
 * Composes both ports for a caller that owns both repositories. `listTransitions`
 * merges the two observation streams in call order rather than letting one port
 * overwrite the other.
 */
export function createTaskLifecycleTransitionPort(deps: {
  taskRuntimeService: TaskLifecyclePortDeps['taskRuntimeService'];
  subtaskRepo: SubtaskLifecyclePortDeps['subtaskRepo'];
  onTransition?(record: TaskLifecycleTransitionRecord): void;
  now?(): string;
}): TaskLifecycleTransitionPort {
  const order: TaskLifecycleTransitionRecord[] = [];
  const observe = (record: TaskLifecycleTransitionRecord) => {
    order.push(record);
    deps.onTransition?.(record);
  };
  const tasks = createTaskLifecyclePort({ ...deps, onTransition: observe });
  const subtasks = createSubtaskLifecyclePort({ ...deps, onTransition: observe });
  return {
    ...tasks,
    ...subtasks,
    listTransitions: () => [...order],
  };
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

/**
 * Facts a caller may pass to describe the canonical lifecycle of a Task it is
 * about to transition. Exposed so Runtime handlers can log the same lifecycle
 * the projection will report.
 */
export function describeTaskLifecycle(input: {
  task: Task;
  hasActiveAttempt: boolean;
  hasOutstandingReplanJob: boolean;
  hasPendingRetryWake: boolean;
  hasPendingUserDecision: boolean;
}): TaskLifecycleState {
  return deriveTaskLifecycleState({
    status: input.task.status,
    hasActiveAttempt: input.hasActiveAttempt,
    hasOutstandingReplanJob: input.hasOutstandingReplanJob,
    hasPendingRetryWake: input.hasPendingRetryWake,
    hasPendingUserDecision: input.hasPendingUserDecision,
  });
}
