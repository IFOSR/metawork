import type Database from 'better-sqlite3';
import type { TaskActivityFactsReader } from '../task/task-activity-facts.js';
import { ACTIVE_REPLAN_STATUSES, RESIDUAL_PUBLICATION_STATUSES, type TaskViewFacts } from '../task/task-view.js';

/** Indexed witnesses: no attempt payload, receipt body, plan or full recovery snapshot is read. */
export class SqliteTaskActivityFacts implements TaskActivityFactsReader {
  constructor(private readonly db: Database.Database) {}
  read(task: TaskViewFacts['task'], pendingPermission: TaskViewFacts['pendingPermission']): TaskViewFacts {
    const dispatch = this.db.prepare(`SELECT attempt_id AS attemptId, subtask_id AS subtaskId, status,
      attempt_kind AS attemptKind, created_at AS createdAt, updated_at AS updatedAt FROM kernel_dispatch_items
      WHERE task_id = ? AND status IN ('pending_launch', 'launching', 'running', 'cancelling')
      AND (status = 'cancelling' OR NOT EXISTS (SELECT 1 FROM executor_attempt_receipts r WHERE r.attempt_id = kernel_dispatch_items.attempt_id))
      ORDER BY CASE WHEN status = 'pending_launch' THEN 1 ELSE 0 END LIMIT 1`)
      .get(task.id) as TaskViewFacts['dispatches'][number] | undefined;
    const replan = this.db.prepare(`SELECT id, status, generation_id AS generationId, source_revision AS sourceRevision,
      updated_at AS updatedAt FROM generation_replan_requests WHERE task_id = ?
      AND status IN (${ACTIVE_REPLAN_STATUSES.map(() => '?').join(',')}) LIMIT 1`)
      .get(task.id, ...ACTIVE_REPLAN_STATUSES) as TaskViewFacts['replanJobs'][number] | undefined;
    const recovery = this.db.prepare(`SELECT decision.id AS applicationId, decision.action,
      substr(application.error_summary, 1, 512) AS errorSummary, application.updated_at AS updatedAt
      FROM kernel_decisions decision JOIN kernel_decision_applications application ON application.decision_id = decision.id
      WHERE decision.task_id = ? AND application.status = 'uncertain' LIMIT 1`)
      .get(task.id) as TaskViewFacts['uncertainApplications'][number] | undefined;
    const publication = this.db.prepare(`SELECT id, status FROM workspace_publications WHERE task_id = ?
      AND status IN (${[...RESIDUAL_PUBLICATION_STATUSES].map(() => '?').join(',')}) LIMIT 1`)
      .get(task.id, ...RESIDUAL_PUBLICATION_STATUSES) as TaskViewFacts['publications'][number] | undefined;
    const retry = this.db.prepare(`SELECT resume_at AS resumeAt FROM retry_wakes
      WHERE task_id = ? AND status IN ('armed', 'fired') ORDER BY resume_at ASC LIMIT 1`)
      .get(task.id) as { resumeAt: string } | undefined;
    const recoveryWake = this.db.prepare(`SELECT 1 FROM retry_wakes WHERE task_id = ? AND status = 'recovery_required' LIMIT 1`).get(task.id);
    const capacityWaiting = Boolean(this.db.prepare(`SELECT 1 FROM tasks, json_each(tasks.dependencies_json) dep
      WHERE tasks.id = ? AND json_extract(dep.value, '$.type') = 'kernel_capacity'
        AND json_extract(dep.value, '$.status') = 'waiting' LIMIT 1`).get(task.id));
    const delivery = this.db.prepare(`SELECT d.status FROM workspace_publication_deliveries d
      JOIN workspace_publications p ON p.id = d.publication_id JOIN subtasks s ON s.id = p.subtask_id
      WHERE p.task_id = ? AND p.status = 'integrated' AND s.status = 'awaiting_integration'
      ORDER BY CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END LIMIT 1`).get(task.id) as { status: string } | undefined;
    const deliveryState = delivery ? (delivery.status === 'failed' ? 'failed' : 'pending') : null;
    return { task, pendingPermission, capacityWaiting, deliveryState, dispatches: dispatch ? [dispatch] : [], replanJobs: replan ? [replan] : [],
      uncertainApplications: recovery ? [recovery] : [], publications: publication ? [publication] : [],
      retryWakeAt: retry?.resumeAt ?? null, retryWakeRecoveryRequired: Boolean(recoveryWake),
      subtasks: this.db.prepare(`SELECT id, status FROM subtasks WHERE task_id = ? AND graph_revision =
        (SELECT MAX(revision) FROM work_graph_revisions WHERE task_id = ? AND status = 'active')`)
        .all(task.id, task.id) as TaskViewFacts['subtasks'], receipts: [], completionResidue: [], result: null };
  }
}
