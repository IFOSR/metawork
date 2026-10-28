/**
 * Repair for the pre-fix data shape: a Subtask reached `done` before the
 * completion boundary owned edge handoffs, so its dependent node can never be
 * dispatched (`missing_handoff`).
 *
 * The repair is additive and idempotent: it rebuilds the missing rows from the
 * upstream attempt's own certified safe projection, and it never rewrites a
 * durable conclusion. A Subtask whose safe body cannot be found is reported, not
 * guessed.
 */

import type { Subtask } from '../core/types.js';
import type { ExecutorAttemptReceipt } from '../storage/executor-attempt-receipt-repo.js';
import {
  EdgeHandoffMaterializationError,
  materializeOutgoingHandoffs,
  outgoingHandoffTargets,
  type EdgeHandoffMaterializerDeps,
} from './subtask-handoff-materializer.js';

export interface EdgeHandoffRepairDeps {
  readonly materializer: EdgeHandoffMaterializerDeps;
  readonly subtaskRepo: { listByTask(taskId: string): readonly Subtask[] };
  readonly receiptRepo: { listByTask(taskId: string): readonly ExecutorAttemptReceipt[] };
  readonly results: { findObject(resultId: string): { resultId: string; byteLength: number } | null };
}

export interface EdgeHandoffRepairResult {
  readonly repaired: Array<{ subtaskId: string; targetSubtaskIds: string[] }>;
  readonly skipped: Array<{ subtaskId: string; reason: string }>;
}

/**
 * Backfills missing outgoing handoffs for one Task. Only Subtasks that are
 * already `done`, owe at least one edge and hold a certified safe projection are
 * touched.
 */
export function backfillOutgoingHandoffs(
  deps: EdgeHandoffRepairDeps,
  input: { taskId: string; now: string },
): EdgeHandoffRepairResult {
  const repaired: EdgeHandoffRepairResult['repaired'] = [];
  const skipped: EdgeHandoffRepairResult['skipped'] = [];
  const receipts = deps.receiptRepo.listByTask(input.taskId);
  for (const subtask of deps.subtaskRepo.listByTask(input.taskId)) {
    if (subtask.status !== 'done') continue;
    const targets = outgoingHandoffTargets(deps.subtaskRepo, input.taskId, subtask.id);
    if (targets.length === 0) continue;
    const receipt = latestCertifiedReceipt(receipts, subtask.id);
    if (!receipt) {
      skipped.push({ subtaskId: subtask.id, reason: 'no certified attempt receipt for this Subtask' });
      continue;
    }
    const safeProjectionId = receiptSafeProjectionId(receipt);
    const projection = safeProjectionId
      ? deps.results.findObject(safeProjectionId)
      : null;
    if (!projection) {
      skipped.push({
        subtaskId: subtask.id,
        reason: 'the certified attempt has no safe projection to hand downstream',
      });
      continue;
    }
    try {
      const inserted = materializeOutgoingHandoffs(deps.materializer, {
        taskId: input.taskId,
        subtaskId: subtask.id,
        generationId: subtask.generationId,
        attemptId: receipt.attemptId,
        completionSchemaVersion: receipt.completionSchemaVersion ?? 4,
        // The envelope is not persisted for direct completions; the declared
        // requirement keys are rebuilt from the graph edge itself.
        declaredHandoffs: [],
      }, { resultId: projection.resultId, byteLength: projection.byteLength }, input.now);
      if (inserted > 0) {
        repaired.push({
          subtaskId: subtask.id,
          targetSubtaskIds: targets.map(target => target.toSubtaskId),
        });
      }
    } catch (error) {
      skipped.push({
        subtaskId: subtask.id,
        reason: error instanceof EdgeHandoffMaterializationError
          ? error.message
          : error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { repaired, skipped };
}

function receiptSafeProjectionId(receipt: ExecutorAttemptReceipt): string | null {
  const objects = receipt.parsing?.resultObjects;
  if (!objects || typeof objects !== 'object' || Array.isArray(objects)) return null;
  const value = (objects as Record<string, unknown>).safeProjectionId;
  return typeof value === 'string' && value.trim() ? value : null;
}

function latestCertifiedReceipt(
  receipts: readonly ExecutorAttemptReceipt[],
  subtaskId: string,
): ExecutorAttemptReceipt | null {
  return receipts
    .filter(receipt => (
      receipt.subtaskId === subtaskId
      && (receipt.terminalState === 'completed' || receipt.terminalState === 'uncertified_result')
    ))
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0] ?? null;
}
