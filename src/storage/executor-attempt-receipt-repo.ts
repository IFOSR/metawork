import type Database from 'better-sqlite3';
import type { CompletionContractViolation } from '../execution/completion-protocol.js';

export type ExecutorAttemptTerminalState =
  | 'completed'
  | 'contract_blocked'
  | 'executor_failed'
  | 'heartbeat_lost'
  | 'cancelled_or_stale';

export interface ExecutorAttemptReceipt {
  attemptId: string;
  executionId: string;
  taskId: string;
  subtaskId: string;
  workUnitId: string;
  agentClassName: string;
  startedAt: string;
  completedAt: string;
  terminalState: ExecutorAttemptTerminalState;
  rawResponse: string;
  completionSchemaVersion: number | null;
  parsing: Record<string, unknown>;
  verification: { warnings: string[]; violations: CompletionContractViolation[] };
  errorCode: string | null;
  errorDetail: string | null;
}

export class ExecutorAttemptReceiptRepo {
  constructor(private readonly db: Database.Database) {}

  insert(receipt: ExecutorAttemptReceipt): void {
    this.db.prepare(`
      INSERT INTO executor_attempt_receipts (
        attempt_id, execution_id, task_id, subtask_id, work_unit_id,
        agent_class_name, started_at, completed_at, terminal_state,
        raw_response, completion_schema_version, parsing_json,
        verification_json, error_code, error_detail
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.attemptId,
      receipt.executionId,
      receipt.taskId,
      receipt.subtaskId,
      receipt.workUnitId,
      receipt.agentClassName,
      receipt.startedAt,
      receipt.completedAt,
      receipt.terminalState,
      receipt.rawResponse,
      receipt.completionSchemaVersion,
      JSON.stringify(receipt.parsing),
      JSON.stringify(receipt.verification),
      receipt.errorCode,
      receipt.errorDetail,
    );
  }

  countByTerminal(taskId: string, subtaskId: string, terminalState: ExecutorAttemptTerminalState): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM executor_attempt_receipts
      WHERE task_id = ? AND subtask_id = ? AND terminal_state = ?
    `).get(taskId, subtaskId, terminalState) as { count: number };
    return row.count;
  }

  findByAttemptId(attemptId: string): ExecutorAttemptReceipt | null {
    const row = this.db.prepare('SELECT * FROM executor_attempt_receipts WHERE attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      attemptId: String(row.attempt_id),
      executionId: String(row.execution_id),
      taskId: String(row.task_id),
      subtaskId: String(row.subtask_id),
      workUnitId: String(row.work_unit_id),
      agentClassName: String(row.agent_class_name),
      startedAt: String(row.started_at),
      completedAt: String(row.completed_at),
      terminalState: row.terminal_state as ExecutorAttemptTerminalState,
      rawResponse: String(row.raw_response),
      completionSchemaVersion: row.completion_schema_version == null ? null : Number(row.completion_schema_version),
      parsing: JSON.parse(String(row.parsing_json)) as Record<string, unknown>,
      verification: JSON.parse(String(row.verification_json)) as ExecutorAttemptReceipt['verification'],
      errorCode: row.error_code == null ? null : String(row.error_code),
      errorDetail: row.error_detail == null ? null : String(row.error_detail),
    };
  }
}
