import type Database from 'better-sqlite3';
import type { CompletionContractViolation } from '../execution/completion-protocol.js';

export type ExecutorAttemptTerminalState =
  | 'completed'
  | 'contract_blocked'
  | 'executor_failed'
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
}
