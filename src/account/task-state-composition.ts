/**
 * Composition of the Task state stack (2026-10-22 Task state simplification §4).
 *
 * Only the composition root may wire concrete Storage adapters (ADR-0020). It
 * builds:
 *
 *   - the durable Task lifecycle port (the single state write entry);
 *   - the SQLite facts reader that answers "what is true about this Task";
 *   - the Task state authority that runs the one summary function.
 */

import type Database from 'better-sqlite3';
import { TaskRepo } from '../storage/task-repo.js';
import { TaskStateChangeRepo, TaskStateProjectionOutbox } from '../storage/task-state-change-repo.js';
import { createSqliteTaskLifecyclePort, createSqliteTaskStateTransaction } from '../storage/task-lifecycle-port-adapter.js';
import { SqliteTaskStateFactsReader } from '../storage/task-state-facts-reader.js';
import { TaskResidueReader } from '../execution/task-residue-reader.js';
import { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { readPendingTaskResult } from '../storage/pending-task-result.js';
import { TaskOperationResultRepo } from '../storage/task-operation-result-repo.js';
import { KernelDispatchItemRepo } from '../storage/kernel-dispatch-item-repo.js';
import { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import type { WorkUnitClaimService } from '../execution/work-unit-claim-service.js';
import { TaskStateAuthority } from '../task/task-state-authority.js';
import type { TaskLifecycleTransitionPort } from '../task/task-lifecycle-transition-port.js';

export interface TaskStateStackDeps {
  readonly db: Database.Database;
  readonly taskRepo?: TaskRepo;
  readonly subtaskRepo?: SubtaskRepo;
  readonly workGraphRevisionRepo?: WorkGraphRevisionRepo;
  readonly dispatchItemRepo?: KernelDispatchItemRepo;
  readonly publicationRepo?: WorkspacePublicationRepo;
  readonly workUnitClaimService: Pick<WorkUnitClaimService, 'hasClaimedByTask'>;
  /**
   * Post-commit hook for a Task that just stopped to wait for the user. Used to
   * release its Conversation slot once operations are safely stopped.
   */
  onWaitingForUser?(task: import('../core/types.js').Task): void;
  /** Post-commit projection notification (best effort; the outbox is durable). */
  onProjection?(notification: {
    readonly taskId: string;
    readonly accountId: string;
    readonly conversationId: string;
    readonly stateVersion: number;
  }): void;
}

export interface TaskStateStack {
  readonly lifecyclePort: TaskLifecycleTransitionPort;
  readonly authority: TaskStateAuthority;
  readonly taskRepo: TaskRepo;
  readonly stateChanges: TaskStateChangeRepo;
}

/** The single Task state write entry. Safe to build before other services exist. */
export function createTaskLifecyclePort(
  db: Database.Database,
  subtaskRepo?: SubtaskRepo,
): TaskLifecycleTransitionPort {
  return createSqliteTaskLifecyclePort(db, {
    taskRepo: new TaskRepo(db),
    subtaskRepo: subtaskRepo ?? new SubtaskRepo(db),
    stateChanges: new TaskStateChangeRepo(db),
    projectionOutbox: new TaskStateProjectionOutbox(db),
    workGraphRevisionRepo: new WorkGraphRevisionRepo(db),
  });
}

/** The facts reader + authority. Needs the residue reader's claim service. */
export function createTaskStateAuthority(deps: TaskStateStackDeps): TaskStateAuthority {
  const taskRepo = deps.taskRepo ?? new TaskRepo(deps.db);
  const subtaskRepo = deps.subtaskRepo ?? new SubtaskRepo(deps.db);
  const workGraphRevisionRepo = deps.workGraphRevisionRepo
    ?? new WorkGraphRevisionRepo(deps.db);
  const dispatchItemRepo = deps.dispatchItemRepo ?? new KernelDispatchItemRepo(deps.db);
  const publicationRepo = deps.publicationRepo ?? new WorkspacePublicationRepo(deps.db);
  const residue = new TaskResidueReader({
    db: deps.db,
    dispatchItemRepo,
    publicationRepo,
    workUnitClaimService: deps.workUnitClaimService,
  });
  const lifecycle = createSqliteTaskLifecyclePort(deps.db, {
    taskRepo,
    subtaskRepo,
    stateChanges: new TaskStateChangeRepo(deps.db),
    projectionOutbox: new TaskStateProjectionOutbox(deps.db),
    workGraphRevisionRepo,
  });
  const facts = new SqliteTaskStateFactsReader({
    db: deps.db,
    taskRepo,
    subtaskRepo,
    workGraphRevisionRepo,
    readPendingResult: taskId => readPendingTaskResult(deps.db, taskId),
    residue,
    operationResults: new TaskOperationResultRepo(deps.db),
  });
  return new TaskStateAuthority({
    facts,
    stateChanges: new TaskStateChangeRepo(deps.db),
    taskRepo,
    lifecycle,
    transaction: createSqliteTaskStateTransaction(deps.db),
    ...(deps.onWaitingForUser ? { onWaitingForUser: deps.onWaitingForUser } : {}),
    ...(deps.onProjection
      ? {
          onChanged: task => deps.onProjection!({
            taskId: task.id,
            accountId: task.accountId ?? 'legacy-account',
            conversationId: task.conversationId ?? 'legacy-conversation',
            stateVersion: task.stateVersion,
          }),
        }
      : {}),
  });
}

export function createTaskStateStack(deps: TaskStateStackDeps): TaskStateStack {
  const taskRepo = deps.taskRepo ?? new TaskRepo(deps.db);
  const lifecyclePort = createTaskLifecyclePort(deps.db, deps.subtaskRepo);
  return {
    lifecyclePort,
    authority: createTaskStateAuthority({ ...deps, taskRepo }),
    taskRepo,
    stateChanges: new TaskStateChangeRepo(deps.db),
  };
}
