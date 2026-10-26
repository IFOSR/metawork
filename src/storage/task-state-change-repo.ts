import type Database from 'better-sqlite3';
import type { TaskStatus } from '../task/task-state.js';
import { normalizeTaskStateDetail, type TaskStateDetail } from '../task/task-state.js';

/**
 * Durable Task state change ledger.
 *
 * One row per applied Task state version. It is the durable audit trail of the
 * six-state model, the idempotency index for `operationKey` and the evidence a
 * pending-action query uses to know an item was already resolved. It is not a
 * second lifecycle and it never drives scheduling.
 */

export interface TaskStateChangeRecord {
  readonly taskId: string;
  readonly version: number;
  readonly operationKey: string;
  readonly decisionId: string;
  readonly fromStatus: TaskStatus;
  readonly toStatus: TaskStatus;
  readonly detail: TaskStateDetail;
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
}

interface TaskStateChangeRow {
  task_id: string;
  version: number;
  operation_key: string;
  decision_id: string;
  from_status: TaskStatus;
  to_status: TaskStatus;
  detail_json: string;
  evidence_refs_json: string;
  created_at: string;
}

function rowToRecord(row: TaskStateChangeRow): TaskStateChangeRecord {
  return {
    taskId: row.task_id,
    version: row.version,
    operationKey: row.operation_key,
    decisionId: row.decision_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    detail: normalizeTaskStateDetail(JSON.parse(row.detail_json)),
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
    createdAt: row.created_at,
  };
}

/** Deterministic operation keys so a repeated request is a no-op, not a new state. */
export const TaskOperationKeys = Object.freeze({
  acceptResult: (attemptId: string, resultId: string) => `accept_result:${attemptId}:${resultId}`,
  retryResult: (attemptId: string, resultId: string) => `retry_result:${attemptId}:${resultId}`,
  cancel: (decisionId: string) => `cancel:${decisionId}`,
  transition: (decisionId: string) => `transition:${decisionId}`,
  migration: (taskId: string) => `migration:${taskId}`,
});

export class TaskStateChangeRepo {
  constructor(private readonly db: Database.Database) {}

  findByOperationKey(taskId: string, operationKey: string): TaskStateChangeRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM task_state_changes WHERE task_id = ? AND operation_key = ?',
    ).get(taskId, operationKey) as TaskStateChangeRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findByVersion(taskId: string, version: number): TaskStateChangeRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM task_state_changes WHERE task_id = ? AND version = ?',
    ).get(taskId, version) as TaskStateChangeRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listForTask(taskId: string, limit = 50): TaskStateChangeRecord[] {
    return (this.db.prepare(`
      SELECT * FROM task_state_changes WHERE task_id = ?
      ORDER BY version DESC LIMIT ?
    `).all(taskId, limit) as TaskStateChangeRow[]).map(rowToRecord);
  }

  /** True when this exact result identity was already resolved by a state change. */
  hasResolvedResult(taskId: string, attemptId: string, resultId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM task_state_changes
      WHERE task_id = ? AND operation_key IN (?, ?) LIMIT 1`).get(
      taskId,
      TaskOperationKeys.acceptResult(attemptId, resultId),
      TaskOperationKeys.retryResult(attemptId, resultId),
    );
  }

  insert(record: TaskStateChangeRecord): void {
    this.db.prepare(`
      INSERT INTO task_state_changes (
        task_id, version, operation_key, decision_id, from_status, to_status,
        detail_json, evidence_refs_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.taskId,
      record.version,
      record.operationKey,
      record.decisionId,
      record.fromStatus,
      record.toStatus,
      JSON.stringify(record.detail),
      JSON.stringify(record.evidenceRefs),
      record.createdAt,
    );
  }
}

export interface TaskStateProjectionNotification {
  readonly sequence: number;
  readonly taskId: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly stateVersion: number;
  readonly status: TaskStatus;
  readonly detail: TaskStateDetail;
  readonly createdAt: string;
}

/**
 * Durable projection notification outbox. A committed Task state change appends
 * one row in the same transaction; delivery attempts read it without holding
 * the state transaction and retry from the durable row.
 */
export class TaskStateProjectionOutbox {
  constructor(private readonly db: Database.Database) {}

  append(input: {
    taskId: string;
    accountId: string;
    conversationId: string;
    stateVersion: number;
    status: TaskStatus;
    detail: TaskStateDetail;
    createdAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO task_state_projection_outbox (
        task_id, account_id, conversation_id, state_version, status, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.taskId, input.accountId, input.conversationId, input.stateVersion,
      input.status, JSON.stringify(input.detail), input.createdAt,
    );
  }

  listPending(limit = 64): TaskStateProjectionNotification[] {
    return (this.db.prepare(`
      SELECT * FROM task_state_projection_outbox
      WHERE dispatched_at IS NULL ORDER BY sequence LIMIT ?
    `).all(limit) as Array<{
      sequence: number; task_id: string; account_id: string; conversation_id: string;
      state_version: number; status: TaskStatus; detail_json: string; created_at: string;
    }>).map(row => ({
      sequence: row.sequence,
      taskId: row.task_id,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      stateVersion: row.state_version,
      status: row.status,
      detail: normalizeTaskStateDetail(JSON.parse(row.detail_json)),
      createdAt: row.created_at,
    }));
  }

  markDispatched(sequence: number, at: string): void {
    this.db.prepare('UPDATE task_state_projection_outbox SET dispatched_at = ? WHERE sequence = ?')
      .run(at, sequence);
  }
}
