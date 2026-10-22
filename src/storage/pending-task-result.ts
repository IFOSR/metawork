import type Database from 'better-sqlite3';
import { ExecutorAttemptReceiptRepo } from './executor-attempt-receipt-repo.js';
import { resolveSafeResult, type PendingResultIdentity, type SafeResultObject } from '../task/safe-result-identity.js';

/** Shared indexed selection for controls and every TaskView surface. Historical receipts cannot resurrect buttons. */
export function readPendingTaskResult(db: Database.Database, taskId: string): PendingResultIdentity | null {
  const candidate = db.prepare(`SELECT r.attempt_id, t.account_id FROM executor_attempt_receipts r
    JOIN tasks t ON t.id = r.task_id JOIN subtasks s ON s.id = r.subtask_id
    JOIN work_graph_revisions g ON g.task_id = r.task_id AND g.status = 'active'
      AND g.generation_id = r.generation_id AND g.revision = r.graph_revision
    WHERE r.task_id = ? AND r.terminal_state = 'uncertified_result'
      AND t.status NOT IN ('done','archived','cancelled') AND s.status = 'awaiting_decision'
      AND s.generation_id = r.generation_id AND s.graph_revision = r.graph_revision
      AND NOT EXISTS (SELECT 1 FROM kernel_dispatch_items d WHERE d.subtask_id = r.subtask_id
        AND d.generation_id = r.generation_id AND (d.created_at > r.started_at AND d.attempt_id != r.attempt_id)
        AND d.status IN ('pending_launch','launching','running','cancelling'))
      AND NOT EXISTS (SELECT 1 FROM executor_attempt_receipts newer WHERE newer.subtask_id = r.subtask_id
        AND newer.generation_id = r.generation_id AND (newer.completed_at > r.completed_at OR (newer.completed_at = r.completed_at AND newer.rowid > r.rowid)))
    ORDER BY r.completed_at DESC, r.rowid DESC LIMIT 1`).get(taskId) as
    { attempt_id: string; account_id: string } | undefined;
  if (!candidate) return null;
  const receipts = new ExecutorAttemptReceiptRepo(db);
  const receipt = receipts.findByAttemptId(candidate.attempt_id)!;
  const pair = resolveSafeResult({ accountId: candidate.account_id, receipt,
    findReceipt: id => receipts.findByAttemptId(id), findObject: id => (db.prepare(`SELECT result_id AS resultId,
      account_id AS accountId, task_id AS taskId, generation_id AS generationId, source_subtask_id AS sourceSubtaskId,
      attempt_id AS attemptId, kind, byte_length AS byteLength, completeness FROM result_objects WHERE result_id = ?`)
      .get(id) as SafeResultObject | undefined) ?? null });
  return pair ? { taskId, generationId: receipt.generationId, graphRevision: receipt.graphRevision,
    subtaskId: receipt.subtaskId, attemptId: receipt.attemptId, resultId: pair.resultObjectId } : null;
}
