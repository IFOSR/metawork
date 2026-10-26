import type Database from 'better-sqlite3';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskStateChangeRepo, TaskStateProjectionOutbox } from '../../src/storage/task-state-change-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { createSqliteTaskLifecyclePort } from '../../src/storage/task-lifecycle-port-adapter.js';
import {
  allowedTaskStatusTransitions,
  createTaskReason,
  EMPTY_TASK_STATE_DETAIL,
  isTerminalTaskStatus,
  type TaskStateDetail,
  type TaskStatus,
} from '../../src/task/task-state.js';
import type { Task } from '../../src/core/types.js';

/**
 * Fixture seam for tests that need a Task in a given state before exercising a
 * subsystem. It uses the real durable Task state port and walks the real
 * transition table, so a fixture can never encode a transition the production
 * model would reject.
 */
export function setTaskStatus(
  db: Database.Database,
  taskId: string,
  target: TaskStatus,
  detail: TaskStateDetail = EMPTY_TASK_STATE_DETAIL,
): Task {
  const taskRepo = new TaskRepo(db);
  const port = createSqliteTaskLifecyclePort(db, {
    taskRepo,
    subtaskRepo: new SubtaskRepo(db),
    stateChanges: new TaskStateChangeRepo(db),
    projectionOutbox: new TaskStateProjectionOutbox(db),
    workGraphRevisionRepo: new WorkGraphRevisionRepo(db),
  });
  return walk(taskRepo, port, taskId, target, detail);
}

function walk(
  taskRepo: TaskRepo,
  port: ReturnType<typeof createSqliteTaskLifecyclePort>,
  taskId: string,
  target: TaskStatus,
  detail: TaskStateDetail,
): Task {
  const current = taskRepo.findById(taskId);
  if (!current) throw new Error(`fixture Task does not exist: ${taskId}`);
  if (current.status === target) return current;
  if (isTerminalTaskStatus(current.status)) {
    throw new Error(`fixture cannot move terminal Task ${taskId} from ${current.status} to ${target}`);
  }
  const path = shortestPath(current.status, target);
  if (!path) {
    throw new Error(`fixture has no legal path from ${current.status} to ${target}`);
  }
  let task = current;
  for (const [index, status] of path.entries()) {
    task = port.applyTaskChange({
      taskId,
      decisionId: `fixture:${taskId}:${index}:${status}`,
      operationKey: `fixture:${taskId}:${index}:${status}`,
      expectedVersion: task.stateVersion,
      generationId: null,
      graphRevision: null,
      to: status,
      detail: status === target ? detail : EMPTY_TASK_STATE_DETAIL,
      actor: 'task-domain',
      reason: 'test fixture',
    }).task;
  }
  return task;
}

/** Durable reason detail for a fixture that needs a specific waiting reason. */
export function withReason(reason: string): TaskStateDetail {
  return {
    ...EMPTY_TASK_STATE_DETAIL,
    reason: createTaskReason('input_required', reason),
  };
}

function shortestPath(from: TaskStatus, to: TaskStatus): TaskStatus[] | null {
  if (from === to) return [];
  const queue: Array<{ status: TaskStatus; path: TaskStatus[] }> = [{ status: from, path: [] }];
  const seen = new Set<TaskStatus>([from]);
  while (queue.length > 0) {
    const head = queue.shift()!;
    for (const next of allowedTaskStatusTransitions(head.status)) {
      if (seen.has(next)) continue;
      const path = [...head.path, next];
      if (next === to) return path;
      seen.add(next);
      queue.push({ status: next, path });
    }
  }
  return null;
}

/**
 * Recording Task state authority for Runtime unit tests that exercise one
 * handler. Production composition always injects the real authority; a test
 * that expects a reconciliation can assert it through `calls`.
 */
export function recordingTaskStateAuthority() {
  const calls: Array<Parameters<import('../../src/task/task-state-authority.js').TaskStateAuthority['reconcile']>[0]> = [];
  const authority = {
    reconcile: (input: Parameters<import('../../src/task/task-state-authority.js').TaskStateAuthority['reconcile']>[0]) => {
      calls.push(input);
      return null;
    },
    readFacts: () => null,
  } as unknown as import('../../src/task/task-state-authority.js').TaskStateAuthority;
  return { authority, calls };
}

/** Task lifecycle port stub for Runtime unit tests that never write a conclusion. */
export function recordingTaskLifecyclePort() {
  const commands: Array<Parameters<import('../../src/task/task-lifecycle-transition-port.js').TaskLifecyclePort['applyTaskChange']>[0]> = [];
  const port = {
    applyTaskChange: (command: Parameters<import('../../src/task/task-lifecycle-transition-port.js').TaskLifecyclePort['applyTaskChange']>[0]) => {
      commands.push(command);
      throw new Error('recording Task lifecycle port does not persist state');
    },
    listTransitions: () => [],
  } as unknown as import('../../src/task/task-lifecycle-transition-port.js').TaskLifecyclePort;
  return { port, commands };
}

/**
 * Complete Task value for fixtures that need a Task-shaped object without a
 * database. It carries the six-state contract fields so a fixture cannot create
 * a Task shape the domain would reject.
 */
export function taskRecord(overrides: Partial<Task> = {}): Task {
  const now = '2026-10-22T00:00:00.000Z';
  return {
    id: 'task_fixture',
    title: 'Task',
    goal: 'Goal',
    status: 'running',
    stateVersion: 1,
    stateDetail: EMPTY_TASK_STATE_DETAIL,
    completedAt: null,
    archivedAt: null,
    retryOfTaskId: null,
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [],
    prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Fixture cancellation through the real state entry. Used by tests that need a
 * cancelled Task without going through the Kernel.
 */
export function cancelFixtureTask(db: Database.Database, taskId: string, reason: string): Task {
  return setTaskStatus(db, taskId, 'cancelled', {
    reason: createTaskReason('user_cancelled', reason),
    unresolved: [],
    phase: 'stopping',
    pendingActions: [],
    requiredWork: [],
    cleanup: { state: 'none', objects: [], reason: '' },
    nextWakeAt: null,
  });
}
