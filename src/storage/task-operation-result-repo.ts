import type Database from 'better-sqlite3';
import type { TaskReasonCode, TaskRequiredWorkKind } from '../task/task-state.js';

/**
 * Normalized operation result (2026-10-22 Task state simplification §5.1).
 *
 * Execution, publication, delivery and service start each report one durable
 * result: success, definite failure, or unknown. The records stay in their own
 * tables; this table is the shared normalized fact the Task summary reads, so a
 * Runtime branch no longer decides a Task status from a caught error string.
 */
export type TaskOperationOutcome = 'success' | 'definite_failure' | 'unknown';

export interface TaskOperationResultRecord {
  readonly taskId: string;
  readonly operationKey: string;
  readonly operationKind: Extract<TaskRequiredWorkKind, 'execution' | 'integration' | 'delivery' | 'safety_report' | 'service'>;
  readonly outcome: TaskOperationOutcome;
  readonly reasonCode: TaskReasonCode | null;
  readonly message: string;
  readonly evidenceRefs: readonly string[];
  readonly updatedAt: string;
}

interface Row {
  task_id: string;
  operation_key: string;
  operation_kind: TaskOperationResultRecord['operationKind'];
  outcome: TaskOperationOutcome;
  reason_code: TaskReasonCode | null;
  message: string;
  evidence_refs_json: string;
  updated_at: string;
}

export class TaskOperationResultRepo {
  constructor(private readonly db: Database.Database) {}

  record(record: TaskOperationResultRecord): void {
    this.db.prepare(`
      INSERT INTO task_operation_results (
        task_id, operation_key, operation_kind, outcome, reason_code, message,
        evidence_refs_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, operation_key) DO UPDATE SET
        operation_kind = excluded.operation_kind,
        outcome = excluded.outcome,
        reason_code = excluded.reason_code,
        message = excluded.message,
        evidence_refs_json = excluded.evidence_refs_json,
        updated_at = excluded.updated_at
    `).run(
      record.taskId,
      record.operationKey,
      record.operationKind,
      record.outcome,
      record.reasonCode,
      record.message.slice(0, 320),
      JSON.stringify(record.evidenceRefs.slice(0, 8)),
      record.updatedAt,
    );
  }

  listByTask(taskId: string): TaskOperationResultRecord[] {
    return (this.db.prepare(`
      SELECT * FROM task_operation_results WHERE task_id = ? ORDER BY updated_at
    `).all(taskId) as Row[]).map(row => ({
      taskId: row.task_id,
      operationKey: row.operation_key,
      operationKind: row.operation_kind,
      outcome: row.outcome,
      reasonCode: row.reason_code,
      message: row.message,
      evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
      updatedAt: row.updated_at,
    }));
  }
}
