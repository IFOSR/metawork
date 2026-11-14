/**
 * Task Runtime recovery items (ADR-0055 §5, D6).
 *
 * An operation whose application was interrupted without a settled outcome
 * becomes exactly one explicit recovery item carrying the operation it was
 * applying, so restart recovery can inspect durable facts and decide: already
 * applied, safe to retry, or requires an explicit user decision.
 *
 * Not a decision ledger: only interrupted applications are stored, no events are
 * queued and nothing is replayed.
 */
import type Database from 'better-sqlite3';
import type { ControlDecision } from '../control/control-contracts.js';
import type { ControlDecisionApplicationRecord } from '../control/control-workflow.js';
import type { DispatchRecoveryFacts, RecoveryApplicationFact } from '../execution/control-application-recovery.js';
import { ControlDispatchItemRepo } from './dispatch-item-repo.js';
import { ExecutorAttemptReceiptRepo } from './executor-attempt-receipt-repo.js';
import { SubtaskRepo } from './subtask-repo.js';
import { WorkGraphRevisionRepo } from './work-graph-revision-repo.js';
import { formatApplicationSettlement } from '../control/control-application-settlement.js';

export type TaskRecoveryItemStatus = 'pending' | 'retry_authorized' | 'assumed_applied';

export interface TaskRecoveryItemRecord
  extends Omit<ControlDecisionApplicationRecord, 'status'> {
  status: TaskRecoveryItemStatus;
}

export interface RecordTaskRecoveryItemInput {
  operation: ControlDecision;
  taskId: string;
  subtaskId: string | null;
  attemptId: string | null;
  errorSummary: string | null;
  createdAt: string;
}

interface TaskRecoveryItemRow {
  id: string;
  decision_id: string;
  event_id: string;
  idempotency_key: string;
  status: TaskRecoveryItemStatus;
  apply_attempts: number;
  observation_event_json: string | null;
  error_summary: string | null;
  decision_json: string;
  created_at: string;
  updated_at: string;
  task_id: string;
  subtask_id: string | null;
  attempt_id: string | null;
}

const TASK_RECOVERY_ITEMS_SQL = `
  CREATE TABLE IF NOT EXISTS task_recovery_items (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'retry_authorized', 'assumed_applied')),
    apply_attempts INTEGER NOT NULL DEFAULT 1,
    observation_event_json TEXT,
    error_summary TEXT,
    decision_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    task_id TEXT NOT NULL,
    subtask_id TEXT,
    attempt_id TEXT
  );
  CREATE INDEX IF NOT EXISTS task_recovery_items_task
    ON task_recovery_items(task_id, status, created_at);
  CREATE INDEX IF NOT EXISTS task_recovery_items_pending
    ON task_recovery_items(status, created_at, id);
`;

export function ensureTaskRecoveryItemSchema(db: Database.Database): void {
  db.exec(TASK_RECOVERY_ITEMS_SQL);
}

export class TaskRecoveryItemRepo {
  constructor(private readonly db: Database.Database) {
    ensureTaskRecoveryItemSchema(db);
  }

  record(input: RecordTaskRecoveryItemInput): TaskRecoveryItemRecord | null {
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO task_recovery_items (
        id, decision_id, event_id, idempotency_key, status, apply_attempts,
        observation_event_json, error_summary, decision_json, created_at,
        updated_at, task_id, subtask_id, attempt_id
      ) VALUES (?, ?, ?, ?, 'pending', 1, NULL, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.operation.id, input.operation.id, input.operation.eventId,
      `${input.operation.eventId}:${input.operation.action.type}`,
      input.errorSummary, JSON.stringify(input.operation), input.createdAt,
      input.createdAt, input.taskId, input.subtaskId, input.attemptId,
    );
    return inserted.changes === 1 ? this.findRecoveryItem(input.operation.id) : null;
  }

  findRecoveryItem(id: string): TaskRecoveryItemRecord | null {
    const row = this.db.prepare('SELECT * FROM task_recovery_items WHERE id = ?')
      .get(id) as TaskRecoveryItemRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  readDispatchRecoveryFacts(application: RecoveryApplicationFact): DispatchRecoveryFacts {
    const action = application.decision.action;
    if (action.type !== 'dispatch_batch') throw new Error('dispatch recovery facts require a dispatch batch');
    const taskId = action.taskId;
    const revision = new WorkGraphRevisionRepo(this.db).findLatest(taskId);
    const binding = revision ? this.db.prepare(`SELECT binding_fingerprint, created_at
      FROM conversation_execution_bindings WHERE task_id = ? AND generation_id = ?`)
      .get(taskId, revision.generationId) as DispatchRecoveryFacts['binding'] | undefined : null;
    const unsettled = this.db.prepare(`SELECT 1 FROM workspace_git_operations operation
      JOIN tasks task ON task.id = ? AND task.workspace_id = operation.workspace_id
      WHERE operation.state <> 'applied'
        AND (operation.conversation_id IS NULL OR operation.conversation_id = task.conversation_id)
      LIMIT 1`).get(taskId);
    const ownAttemptEffects = action.items.some(item => this.db.prepare(`
      SELECT 1 FROM dispatch_items WHERE attempt_id = ?
      UNION ALL SELECT 1 FROM executor_attempt_runtime WHERE attempt_id = ?
      UNION ALL SELECT 1 FROM executor_attempt_receipts WHERE attempt_id = ?
      UNION ALL SELECT 1 FROM attempt_sandboxes WHERE attempt_id = ?
      UNION ALL SELECT 1 FROM work_units WHERE claimed_attempt_id = ?
      LIMIT 1`).get(...Array<string>(5).fill(item.attemptId)) !== undefined);
    return { revision, binding: binding ?? null, workspaceSettled: !unsettled,
      ownAttemptEffects, subtasks: new SubtaskRepo(this.db).listByTask(taskId),
      dispatches: new ControlDispatchItemRepo(this.db).listByTask(taskId),
      receipts: new ExecutorAttemptReceiptRepo(this.db).listByTask(taskId),
      routes: this.db.prepare(`SELECT task_id,generation_id,subtask_id,graph_revision,
        configuration_revision,attempt_ordinal,outcome,created_at FROM route_decisions WHERE task_id = ?`)
        .all(taskId) as unknown as DispatchRecoveryFacts['routes'] };
  }

  listUnresolved(taskId?: string): TaskRecoveryItemRecord[] {
    return (this.db.prepare(`SELECT * FROM task_recovery_items
      WHERE status IN ('pending','retry_authorized') ${taskId ? 'AND task_id = ?' : ''}
      ORDER BY created_at ASC,id ASC`).all(...(taskId ? [taskId] : [])) as TaskRecoveryItemRow[]).map(rowToRecord);
  }

  /** Resume a settled duplicate's unfinished completion even after losing its slot. */
  listIncompleteDispatchCompletions(): string[] {
    return (this.db.prepare(`SELECT DISTINCT task.id FROM task_recovery_items item
      JOIN tasks task ON task.id = item.task_id
      JOIN work_graph_revisions graph ON graph.task_id = task.id
        AND graph.revision = (SELECT MAX(revision) FROM work_graph_revisions WHERE task_id = task.id)
      WHERE item.status = 'assumed_applied'
        AND item.error_summary LIKE 'control_settlement/operation_settled:duplicate_dispatch_completed %'
        AND task.status NOT IN ('failed','cancelled')
        AND (graph.status <> 'completed' OR NOT EXISTS (
          SELECT 1 FROM effect_outbox WHERE id = 'workspace_completion:' || task.id || ':' || graph.generation_id
        ) OR NOT EXISTS (
          SELECT 1 FROM conversation_turn_answers WHERE source_task_id = task.id
            AND revision_key = 'result_workspace_completion:' || task.id || ':' || graph.generation_id
        ))`).all() as Array<{ id: string }>).map(row => row.id);
  }

  /** Keep the original error and attach a durable, structured explanation. */
  settleRedundantDispatch(id: string, reason: string, now: string): void {
    const settlement = formatApplicationSettlement({ kind: 'operation_settled',
      code: 'duplicate_dispatch_completed', detail: reason });
    this.db.prepare(`UPDATE task_recovery_items SET status = 'assumed_applied',
      error_summary = ? || char(10) || COALESCE(error_summary, ''), updated_at = ?
      WHERE id = ? AND status IN ('pending','retry_authorized')`).run(settlement, now, id);
  }

  listRecoveryItems(taskId: string): TaskRecoveryItemRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM task_recovery_items
      WHERE task_id = ? AND status IN ('pending', 'retry_authorized')
      ORDER BY created_at ASC, id ASC
    `).all(taskId) as TaskRecoveryItemRow[];
    return rows.map(rowToRecord);
  }

  listByTask(taskId: string): TaskRecoveryItemRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM task_recovery_items WHERE task_id = ? ORDER BY created_at ASC, id ASC
    `).all(taskId) as TaskRecoveryItemRow[];
    return rows.map(rowToRecord);
  }

  listPending(taskId?: string): TaskRecoveryItemRecord[] {
    const rows = taskId
      ? this.db.prepare(`
          SELECT * FROM task_recovery_items
          WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC, id ASC
        `).all(taskId) as TaskRecoveryItemRow[]
      : this.db.prepare(`
          SELECT * FROM task_recovery_items
          WHERE status = 'pending' ORDER BY created_at ASC, id ASC
        `).all() as TaskRecoveryItemRow[];
    return rows.map(rowToRecord);
  }

  /** The revision pin belongs to the interrupted operation, not a parallel column. */
  listRecoveryConfigurationRevisions(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT json_extract(decision_json, '$.configurationRevision') AS revision
      FROM task_recovery_items WHERE status IN ('pending', 'retry_authorized')
    `).all() as Array<{ revision: unknown }>;
    return rows.map(({ revision }) => {
      if (typeof revision !== 'string' || revision.length === 0) {
        throw new Error('recovery operation configuration revision unavailable');
      }
      return revision;
    });
  }

  countPending(taskId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM task_recovery_items
      WHERE task_id = ? AND status IN ('pending', 'retry_authorized')
    `).get(taskId) as { count: number };
    return row.count;
  }

  resolveRecoveryItem(id: string, resolution: 'assume_applied' | 'retry', now: string): void {
    this.db.prepare(`
      UPDATE task_recovery_items
      SET status = ?, apply_attempts = apply_attempts + ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'retry_authorized')
    `).run(
      resolution === 'retry' ? 'retry_authorized' : 'assumed_applied',
      resolution === 'retry' ? 1 : 0, now, id,
    );
  }

  markSettled(id: string, now: string): void {
    this.db.prepare(`
      UPDATE task_recovery_items SET status = 'assumed_applied', updated_at = ? WHERE id = ?
    `).run(now, id);
  }
}

function rowToRecord(row: TaskRecoveryItemRow): TaskRecoveryItemRecord {
  return {
    id: row.id,
    decisionId: row.decision_id,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    applyAttempts: row.apply_attempts,
    observationEvent: row.observation_event_json
      ? JSON.parse(row.observation_event_json) as TaskRecoveryItemRecord['observationEvent']
      : null,
    errorSummary: row.error_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decision: JSON.parse(row.decision_json) as ControlDecision,
  };
}
