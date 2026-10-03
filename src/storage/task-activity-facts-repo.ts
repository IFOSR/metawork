import type Database from 'better-sqlite3';
import type { TaskActivityFactsReader } from '../task/task-activity-facts.js';
import { ACTIVE_REPLAN_STATUSES, RESIDUAL_PUBLICATION_STATUSES, type TaskViewFacts } from '../task/task-view.js';

/** Indexed witnesses: no attempt payload, receipt body, plan or full recovery snapshot is read. */
export class SqliteTaskActivityFacts implements TaskActivityFactsReader {
  constructor(private readonly db: Database.Database) {}
  read(task: TaskViewFacts['task'], pendingPermission: TaskViewFacts['pendingPermission']): TaskViewFacts {
    const dispatch = this.db.prepare(`SELECT attempt_id AS attemptId, subtask_id AS subtaskId, status,
      attempt_kind AS attemptKind, created_at AS createdAt, updated_at AS updatedAt FROM kernel_dispatch_items
      WHERE task_id = ? AND status IN ('pending_launch', 'launching', 'running', 'cancelling') LIMIT 1`)
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
      WHERE task_id = ? AND status IN ('armed', 'fired') ORDER BY resume_at DESC LIMIT 1`)
      .get(task.id) as { resumeAt: string } | undefined;
    const recoveryWake = this.db.prepare(`SELECT 1 FROM retry_wakes WHERE task_id = ? AND status = 'recovery_required' LIMIT 1`).get(task.id);
    return { task, pendingPermission, dispatches: dispatch ? [dispatch] : [], replanJobs: replan ? [replan] : [],
      uncertainApplications: recovery ? [recovery] : [], publications: publication ? [publication] : [],
      retryWakeAt: retry?.resumeAt ?? null, retryWakeRecoveryRequired: Boolean(recoveryWake),
      subtasks: [], receipts: [], completionResidue: [], result: null };
  }
}
