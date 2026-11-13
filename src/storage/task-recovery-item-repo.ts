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
