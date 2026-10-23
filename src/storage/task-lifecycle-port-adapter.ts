import type Database from 'better-sqlite3';
import type { Task, TaskStatus } from '../core/types.js';
import type { TaskStateDetail } from '../task/task-state.js';
import {
  createTaskLifecycleTransitionPort,
  type TaskLifecycleStorePort,
  type TaskLifecycleTransitionPort,
  type TaskStateTransactionPort,
} from '../task/task-lifecycle-transition-port.js';
import { TaskRepo } from './task-repo.js';
import { TaskStateChangeRepo, TaskStateProjectionOutbox } from './task-state-change-repo.js';
import { WorkGraphRevisionRepo } from './work-graph-revision-repo.js';
import { SubtaskRepo } from './subtask-repo.js';

/**
 * SQLite adapter for the Task Domain state port. The domain only knows
 * `TaskLifecycleStorePort`; SQLite stays in Storage (ADR-0020).
 */
export function createSqliteTaskLifecycleStore(
  db: Database.Database,
  repos: {
    taskRepo: TaskRepo;
    stateChanges: TaskStateChangeRepo;
    projectionOutbox: TaskStateProjectionOutbox;
    workGraphRevisionRepo: WorkGraphRevisionRepo;
  },
): TaskLifecycleStorePort {
  return {
    findTask: taskId => repos.taskRepo.findById(taskId),
    findChangeByOperationKey: (taskId, operationKey) => {
      const record = repos.stateChanges.findByOperationKey(taskId, operationKey);
      return record
        ? {
            version: record.version,
            decisionId: record.decisionId,
            toStatus: record.toStatus,
            detail: record.detail,
            createdAt: record.createdAt,
          }
        : null;
    },
    applyTaskState: input => repos.taskRepo.applyTaskState(input),
    appendChange: record => repos.stateChanges.insert(record),
    appendProjection: input => repos.projectionOutbox.append(input),
    activeGraph: taskId => {
      const revision = repos.workGraphRevisionRepo.findActive(taskId);
      return revision
        ? { generationId: revision.generationId, revision: revision.revision }
        : null;
    },
    listChanges: (taskId, limit) => repos.stateChanges.listForTask(taskId, limit),
  };
}

export function createSqliteTaskStateTransaction(db: Database.Database): TaskStateTransactionPort {
  return {
    run: <T>(operation: () => T): T => db.transaction(operation).immediate(),
  };
}

/**
 * Composition-root helper that wires the durable Task lifecycle port over a
 * SQLite database. Runtime code receives the port, never the repository.
 */
export function createSqliteTaskLifecyclePort(
  db: Database.Database,
  options: {
    taskRepo: TaskRepo;
    subtaskRepo: SubtaskRepo;
    stateChanges: TaskStateChangeRepo;
    projectionOutbox: TaskStateProjectionOutbox;
    workGraphRevisionRepo: WorkGraphRevisionRepo;
    onApplied?(record: Parameters<NonNullable<
      Parameters<typeof createTaskLifecycleTransitionPort>[0]['onApplied']
    >>[0]): void;
  },
): TaskLifecycleTransitionPort {
  return createTaskLifecycleTransitionPort({
    store: createSqliteTaskLifecycleStore(db, options),
    transaction: createSqliteTaskStateTransaction(db),
    subtaskRepo: options.subtaskRepo,
    ...(options.onApplied ? { onApplied: options.onApplied } : {}),
  });
}

/** Convenience read used by Runtime code that must CAS against the current version. */
export function currentTaskState(task: Task | null): {
  status: TaskStatus;
  version: number;
  detail: TaskStateDetail;
} | null {
  if (!task) return null;
  return { status: task.status, version: task.stateVersion, detail: task.stateDetail };
}
