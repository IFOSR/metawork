import { readPendingTaskResults } from './pending-task-result.js';
import type Database from 'better-sqlite3';
import type { SubtaskStatus } from '../core/types.js';
import type { KernelDispatchItemStatus } from '../kernel/control-kernel.js';
import type { ExecutorAttemptTerminalState } from './executor-attempt-receipt-repo.js';
import type { TaskRepo } from './task-repo.js';
import type { WorkGraphRevisionRepo } from './work-graph-revision-repo.js';
import type { SubtaskRepo } from './subtask-repo.js';
import { parseCompletionRequirements } from '../task/task-completion-requirements.js';
import { createTaskReason, normalizeCleanup, NO_TASK_CLEANUP } from '../task/task-state.js';
import type {
  TaskRawDispatchFact,
  TaskRawPublicationFact,
  TaskRawReceiptFact,
  TaskRawReplanFact,
  TaskRawRetryWakeFact,
  TaskStateFactsPort,
  TaskStateRawFacts,
} from '../task/task-state-facts.js';
import type { PendingResultIdentity } from '../task/safe-result-identity.js';

/**
 * SQLite reader for the Task state facts port. It reads durable rows only; all
 * interpretation lives in `src/task/task-state-facts.ts` so the Task Domain never
 * imports SQLite.
 */
export interface TaskStateFactsReaderDeps {
  readonly db: Database.Database;
  readonly taskRepo: TaskRepo;
  readonly subtaskRepo: SubtaskRepo;
  readonly workGraphRevisionRepo: WorkGraphRevisionRepo;
  readonly readPendingResult: (taskId: string) => PendingResultIdentity | null;
  readonly residue: {
    blockingReasons(taskId: string, generationId: string | null): readonly string[];
  };
  readonly operationResults: Pick<
    import('./task-operation-result-repo.js').TaskOperationResultRepo,
    'listByTask'
  >;
  /** Bounded retry/startup deadlines recorded by the Kernel retry policy. */
  readonly now?: () => string;
}

export class SqliteTaskStateFactsReader implements TaskStateFactsPort {
  constructor(private readonly deps: TaskStateFactsReaderDeps) {}

  read(taskId: string): TaskStateRawFacts | null {
    const task = this.deps.taskRepo.findById(taskId);
    if (!task) return null;
    // A completed graph no longer has an active revision; the latest revision is
    // still the authority for its requirement snapshot and its Subtasks.
    const activeRevision = this.deps.workGraphRevisionRepo.findActive(taskId);
    const revision = activeRevision ?? this.deps.workGraphRevisionRepo.findLatest(taskId);
    const generationId = revision?.generationId ?? null;
    const subtasks = revision && activeRevision
      ? this.deps.subtaskRepo.listActiveByTask(taskId)
      : this.deps.subtaskRepo.listByTask(taskId)
        .filter(subtask => !revision || subtask.graphRevision === revision.revision);
    const dispatches = this.readDispatches(taskId, generationId, revision?.revision ?? null);
    const receipts = this.readReceipts(taskId, generationId, revision?.revision ?? null);
    const publications = this.readPublications(taskId, generationId, revision?.revision ?? null);
    const retryWakes = this.readRetryWakes(taskId, generationId, revision?.revision ?? null);
    const replans = this.readReplans(taskId, generationId, revision?.revision ?? null);
    const service = this.readService(taskId);
    const pendingResults = readPendingTaskResults(this.deps.db, taskId);
    const pendingResult = pendingResults[0] ?? null;
    const pendingPermission = this.readPendingPermission(taskId);
    const operationResults = this.deps.operationResults.listByTask(taskId)
      .filter(result => !revision || result.updatedAt >= revision.createdAt);
    // A revision authorized before this contract has no recorded snapshot yet;
    // compiling it from that revision's own persisted Subtasks is the documented
    // migration path, never a guessed conclusion.
    const recorded = revision ? parseCompletionRequirements(revision.completionRequirements) : [];
    const requirements = recorded.length > 0
      ? recorded
      : this.compileMigratedRequirements(task, subtasks);
    const residueReasons = revision
      ? this.deps.residue.blockingReasons(taskId, generationId)
      : this.deps.residue.blockingReasons(taskId, null);
    const cleanup = residueReasons.length > 0
      ? {
          state: 'pending' as const,
          objects: [...residueReasons],
          reason: '正在安全收尾。',
        }
      : NO_TASK_CLEANUP;
    const capacityWaiting = this.readCapacityWaiting(taskId);
    return {
      task,
      activeGraph: activeRevision
        ? { generationId: activeRevision.generationId, revision: activeRevision.revision }
        : null,
      operationResults,
      cancelFence: this.readCancelFence(taskId),
      authorizedContinuation: !!this.deps.db.prepare(`SELECT 1 FROM kernel_effect_outbox
        WHERE task_id = ? AND effect_type IN ('task_result_continuation', 'task_remaining_work')
          AND status IN ('pending', 'sending') LIMIT 1`).get(taskId),
      partialAcceptancePending: revision !== null
        && revision.completionKind === null
        && subtasks.length > 0
        && subtasks.some(subtask => subtask.status === 'cancelled')
        && subtasks.every(subtask => subtask.status === 'done' || subtask.status === 'cancelled')
        && retryWakes.every(wake => wake.status !== 'armed' && wake.status !== 'fired'),
      subtasks: subtasks.map(subtask => ({
        id: subtask.id,
        title: subtask.title,
        status: subtask.status,
        dependencySubtaskIds: subtask.dependencies.map(dependency => dependency.fromSubtaskId),
      })),
      dispatches,
      receipts,
      publications,
      retryWakes,
      replans,
      pendingResult,
      pendingResults,
      pendingPermission,
      service,
      serviceRequired: task.startServiceAfterPublish === true
        || requirements.some(requirement => requirement.kind === 'service'),
      slot: this.readSlot(taskId),
      cleanup: normalizeCleanup(cleanup),
      completionRequirements: requirements,
      capacityWaiting,
      externalOutcomeUnknown: this.readExternalOutcomeUnknown(taskId)
        || operationResults.some(result => result.outcome === 'unknown'),
    };
  }

  private readDispatches(taskId: string, generationId: string | null, revision: number | null): TaskRawDispatchFact[] {
    return (this.deps.db.prepare(`SELECT attempt_id, subtask_id, status, generation_id
      FROM kernel_dispatch_items WHERE task_id = ? AND generation_id = ?
      AND subtask_id IN (SELECT id FROM subtasks WHERE task_id = ? AND graph_revision = ?)
      ORDER BY created_at`).all(taskId, generationId, taskId, revision) as Array<{
      attempt_id: string; subtask_id: string; status: KernelDispatchItemStatus; generation_id: string;
    }>).map(row => ({
      attemptId: row.attempt_id,
      subtaskId: row.subtask_id,
      status: row.status,
      generationId: row.generation_id,
    }));
  }

  private readReceipts(taskId: string, generationId: string | null, revision: number | null): TaskRawReceiptFact[] {
    return (this.deps.db.prepare(`SELECT attempt_id, subtask_id, terminal_state, failure_json, completed_at,
        EXISTS (SELECT 1 FROM task_state_changes c WHERE c.task_id = r.task_id
          AND c.operation_key = 'accept_result:' || r.attempt_id || ':' ||
            COALESCE(json_extract(r.parsing_json, '$.resultObjects.safeProjectionId'), '')) AS accepted
      FROM executor_attempt_receipts r WHERE task_id = ? AND generation_id = ? AND graph_revision = ?
      ORDER BY completed_at, rowid`).all(taskId, generationId, revision) as Array<{
      attempt_id: string; subtask_id: string; terminal_state: ExecutorAttemptTerminalState;
      failure_json: string | null; completed_at: string; accepted: number;
    }>).map(row => {
      let failureCode: string | null = null;
      let failureKind: string | null = null;
      if (row.failure_json) {
        try {
          const failure = JSON.parse(row.failure_json) as { code?: unknown; kind?: unknown };
          failureCode = typeof failure.code === 'string' ? failure.code : null;
          failureKind = typeof failure.kind === 'string' ? failure.kind : null;
        } catch {
          failureCode = null;
        }
      }
      return {
        attemptId: row.attempt_id,
        subtaskId: row.subtask_id,
        terminalState: row.terminal_state,
        failureCode: failureCode ?? failureKind,
        failureKind,
        completedAt: row.completed_at,
        accepted: row.accepted === 1,
      };
    });
  }

  private readPublications(taskId: string, generationId: string | null, revision: number | null): TaskRawPublicationFact[] {
    return (this.deps.db.prepare(`SELECT publication.id, publication.subtask_id, publication.status,
        delivery.status AS delivery_status
      FROM workspace_publications AS publication
      LEFT JOIN workspace_publication_deliveries AS delivery
        ON delivery.publication_id = publication.id
      WHERE publication.task_id = ? AND publication.generation_id = ?
        AND publication.subtask_id IN (SELECT id FROM subtasks WHERE task_id = ? AND graph_revision = ?)
      ORDER BY publication.created_at`).all(taskId, generationId, taskId, revision) as Array<{
      id: string; subtask_id: string; status: TaskRawPublicationFact['status'];
      delivery_status: 'pending' | 'failed' | 'succeeded' | null;
    }>).map(row => ({
      id: row.id,
      subtaskId: row.subtask_id,
      status: row.status,
      deliveryStatus: row.delivery_status,
    }));
  }

  private readRetryWakes(taskId: string, generationId: string | null, revision: number | null): TaskRawRetryWakeFact[] {
    return (this.deps.db.prepare(`SELECT wake_id, status, resume_at FROM retry_wakes
      WHERE task_id = ? AND generation_id = ?
        AND subtask_id IN (SELECT id FROM subtasks WHERE task_id = ? AND graph_revision = ?)
      ORDER BY resume_at`).all(taskId, generationId, taskId, revision) as Array<{
      wake_id: string; status: TaskRawRetryWakeFact['status']; resume_at: string;
    }>).map(row => ({ wakeId: row.wake_id, status: row.status, resumeAt: row.resume_at }));
  }

  private readReplans(taskId: string, generationId: string | null, revision: number | null): TaskRawReplanFact[] {
    return (this.deps.db.prepare(`SELECT id, status FROM generation_replan_requests
      WHERE task_id = ? AND generation_id = ? AND source_revision = ? ORDER BY created_at`).all(taskId, generationId, revision) as Array<{
      id: string; status: TaskRawReplanFact['status'];
    }>).map(row => ({ id: row.id, status: row.status }));
  }

  private readService(taskId: string): TaskStateRawFacts['service'] {
    const row = this.deps.db.prepare(`SELECT service_id, state, health_message
      FROM managed_local_services WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1`).get(taskId) as {
      service_id: string; state: NonNullable<TaskStateRawFacts['service']>['state'];
      health_message: string | null;
    } | undefined;
    return row
      ? { serviceId: row.service_id, state: row.state, healthMessage: row.health_message }
      : null;
  }

  private readPendingPermission(taskId: string): { requestId: string } | null {
    const row = this.deps.db.prepare(`SELECT id FROM permission_requests
      WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`).get(taskId) as {
      id: string;
    } | undefined;
    return row ? { requestId: row.id } : null;
  }

  private readSlot(taskId: string): 'none' | 'held' {
    return this.deps.db.prepare(`SELECT 1 FROM conversation_task_slots
      WHERE active_task_id = ? AND state <> 'free' LIMIT 1`).get(taskId) ? 'held' : 'none';
  }

  private readCapacityWaiting(taskId: string): boolean {
    return !!this.deps.db.prepare(`SELECT 1 FROM task_schedule_entries
      WHERE task_id = ? AND state IN ('queued', 'eligible') LIMIT 1`).get(taskId);
  }

  private readExternalOutcomeUnknown(taskId: string): boolean {
    return !!this.deps.db.prepare(`SELECT 1 FROM kernel_dispatch_items
      WHERE task_id = ? AND status = 'uncertain' LIMIT 1`).get(taskId)
      || !!this.deps.db.prepare(`SELECT 1 FROM workspace_publications
        WHERE task_id = ? AND status = 'uncertain' LIMIT 1`).get(taskId)
      || !!this.deps.db.prepare(`SELECT 1 FROM kernel_decision_applications AS application
        INNER JOIN kernel_events AS event ON event.id = application.event_id
        WHERE event.task_id = ? AND application.status = 'uncertain' LIMIT 1`).get(taskId);
  }

  private readCancelFence(taskId: string): boolean {
    return !!this.deps.db.prepare(`SELECT 1 FROM kernel_decisions AS decision
      INNER JOIN kernel_decision_applications AS application
        ON application.decision_id = decision.id
      WHERE decision.task_id = ? AND decision.action = 'cancel_task'
        AND application.status = 'applied' LIMIT 1`).get(taskId);
  }

  /**
   * Revisions authorized before this schema still need a requirement list. It is
   * compiled from the persisted Subtask facts of that revision, never from a
   * guessed Task result.
   */
  private compileMigratedRequirements(
    task: import('../core/types.js').Task,
    subtasks: readonly import('../core/types.js').Subtask[],
  ): TaskStateRawFacts['completionRequirements'] {
    if (subtasks.length === 0) return [];
    return subtasks.flatMap(subtask => {
      const entries: TaskStateRawFacts['completionRequirements'][number][] = [{
        key: `execution:${subtask.id}`,
        kind: 'execution',
        label: subtask.title,
        subtaskId: subtask.id,
        serviceId: null,
      }];
      if (task.publicProject || (subtask.fileOutputs?.length ?? 0) > 0) {
        entries.push({
          key: `delivery:${subtask.id}`,
          kind: 'delivery',
          label: `${subtask.title} 的文件交付`,
          subtaskId: subtask.id,
          serviceId: null,
        });
      }
      if (subtask.deliveryKind === 'report') {
        entries.push({
          key: `safety_report:${subtask.id}`,
          kind: 'safety_report',
          label: `${subtask.title} 的安全报告交付`,
          subtaskId: subtask.id,
          serviceId: null,
        });
      }
      return entries;
    }).concat(task.startServiceAfterPublish
      ? [{
          key: 'service',
          kind: 'service' as const,
          label: '启动并接管本地服务',
          subtaskId: null,
          serviceId: null,
        }]
      : []);
  }
}

/** Reason for a cleanup that is still pending after a terminal conclusion. */
export function cleanupDetail(reasons: readonly string[]) {
  if (reasons.length === 0) return NO_TASK_CLEANUP;
  return {
    state: 'pending' as const,
    objects: [...reasons],
    reason: '正在安全收尾。',
  };
}

/** Normalizes a raw subtask status for diagnostics outside this reader. */
export function subtaskStatusOf(status: SubtaskStatus): SubtaskStatus {
  return status;
}

/** Bounded reason helper shared with callers that classify failure facts. */
export function failureReasonFromCode(code: string | null, evidence: string) {
  if (!code) return createTaskReason('execution_failed', '必需工作失败。', [evidence]);
  if (code.includes('EADDRINUSE') || code.includes('port_in_use') || code.includes('port_in_use_error')) {
    return createTaskReason('port_in_use', '端口已被占用。', [evidence]);
  }
  if (code.includes('ENOENT') || code.includes('command_not_found')) {
    return createTaskReason('command_not_found', '所需的命令不存在。', [evidence]);
  }
  if (code.includes('health')) {
    return createTaskReason('service_health_timeout', '服务未在期限内通过健康检查。', [evidence]);
  }
  return createTaskReason('execution_failed', '必需工作失败。', [evidence]);
}
