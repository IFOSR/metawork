import type Database from 'better-sqlite3';
import type { CompletionContractViolation } from '../execution/completion-protocol.js';
import type { KernelFailure } from '../core/kernel-failure.js';
import type { KernelAttemptKind, KernelRecoveryMode } from '../kernel/control-kernel.js';

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
  graphRevision: number;
  generationId: string;
  attemptKind: KernelAttemptKind;
  sourceAttemptId: string | null;
  failure: KernelFailure | null;
  recoveryMode: KernelRecoveryMode;
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

export type ExecutorAttemptReceiptInsert = Omit<
  ExecutorAttemptReceipt,
  'graphRevision' | 'generationId' | 'attemptKind' | 'sourceAttemptId' | 'recoveryMode'
>;

export class ExecutorAttemptReceiptRepo {
  constructor(private readonly db: Database.Database) {}

  insert(receipt: ExecutorAttemptReceiptInsert): void {
    const subtask = this.db.prepare(`
      SELECT graph_revision, generation_id FROM subtasks WHERE id = ?
    `).get(receipt.subtaskId) as { graph_revision: number | null; generation_id: string | null } | undefined;
    const dispatchItem = this.db.prepare(`
      SELECT attempt_kind, source_attempt_id, recovery_mode
      FROM kernel_dispatch_items
      WHERE attempt_id = ?
    `).get(receipt.attemptId) as {
      attempt_kind: KernelAttemptKind;
      source_attempt_id: string | null;
      recovery_mode: KernelRecoveryMode;
    } | undefined;
    this.db.prepare(`
      INSERT INTO executor_attempt_receipts (
        attempt_id, execution_id, task_id, subtask_id, work_unit_id,
        agent_class_name, started_at, completed_at, terminal_state,
        raw_response, completion_schema_version, parsing_json,
        verification_json, error_code, error_detail, graph_revision,
        generation_id, attempt_kind, source_attempt_id, failure_json, recovery_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      subtask?.graph_revision ?? 1,
      subtask?.generation_id ?? `generation_${receipt.taskId}_1`,
      dispatchItem?.attempt_kind ?? 'primary',
      dispatchItem?.source_attempt_id ?? null,
      receipt.failure ? JSON.stringify(receipt.failure) : null,
      dispatchItem?.recovery_mode ?? 'fresh',
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
    return row ? rowToReceipt(row) : null;
  }

  listByTask(taskId: string): ExecutorAttemptReceipt[] {
    const rows = this.db.prepare(`
      SELECT * FROM executor_attempt_receipts
      WHERE task_id = ?
      ORDER BY completed_at DESC, attempt_id ASC
    `).all(taskId) as Record<string, unknown>[];
    return rows.map(rowToReceipt);
  }
}

function rowToReceipt(row: Record<string, unknown>): ExecutorAttemptReceipt {
  return {
      attemptId: String(row.attempt_id),
      executionId: String(row.execution_id),
      taskId: String(row.task_id),
      subtaskId: String(row.subtask_id),
      graphRevision: Number(row.graph_revision ?? 1),
      generationId: String(row.generation_id ?? `generation_${String(row.task_id)}_1`),
      attemptKind: String(row.attempt_kind ?? 'primary') as KernelAttemptKind,
      sourceAttemptId: row.source_attempt_id == null ? null : String(row.source_attempt_id),
      failure: row.failure_json == null ? null : JSON.parse(String(row.failure_json)) as KernelFailure,
      recoveryMode: String(row.recovery_mode ?? 'fresh') as KernelRecoveryMode,
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
