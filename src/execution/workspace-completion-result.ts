import type { Subtask } from '../core/types.js';
import type { ConversationResultDelivery } from '../session/conversation-session.js';
import type { ExecutorAttemptReceiptRepo } from '../storage/executor-attempt-receipt-repo.js';
import type { ResultObjectRepo } from '../storage/result-object-repo.js';
import { resolveSafeResult } from '../task/safe-result-identity.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';

/** A Workspace completion must cross the same durable result boundary as an Attempt. */
export function workspaceCompletionResult(input: {
  accountId: string;
  taskId: string;
  generationId: string;
  resultId: string;
  subtasks: Subtask[];
  receipts: ExecutorAttemptReceiptRepo;
  results: ResultObjectRepo;
  summary?: string;
  serviceStatus?: string;
  acceptedAttemptIds?: ReadonlySet<string>;
}): ConversationResultDelivery | null {
  const sources = workspaceCompletionSources(input);
  if (!sources || (sources.length > 1 && !input.summary?.trim())) return null;
  const last = sources.at(-1)!;
  const content = redactSensitiveText(['任务已完成。',
    ...(input.serviceStatus ? [input.serviceStatus, '执行阶段记录：'] : []),
    sources.length === 1 ? sources[0]!.content : input.summary!.trim(),
  ].join('\n\n'));
  const object = input.results.putObject({
    resultId: input.resultId, accountId: input.accountId, taskId: input.taskId,
    generationId: input.generationId, sourceSubtaskId: last.subtask.id,
    attemptId: last.safe.resultOwnerAttemptId, kind: 'business_result',
    mediaType: 'text/markdown', content, completeness: 'complete', retentionClass: 'task',
  });
  return { resultId: object.resultId, content, completeness: 'complete', certification: 'certified' };
}

export function workspaceCompletionSources(input: {
  accountId: string;
  taskId: string;
  generationId: string;
  subtasks: Subtask[];
  receipts: ExecutorAttemptReceiptRepo;
  results: ResultObjectRepo;
  /**
   * Attempts whose result the user explicitly accepted. Task facts already
   * treat such a receipt as its node's completion evidence; the final answer
   * must use the same rule instead of demanding `terminalState === 'completed'`
   * (2026-11-11: acceptance advanced the graph but completion then failed with
   * `workspace_completion_missing_certified_results`, leaving the Task blocked).
   */
  acceptedAttemptIds?: ReadonlySet<string>;
}): Array<{ title: string; content: string; subtask: Subtask; safe: NonNullable<ReturnType<typeof resolveSafeResult>> }> | null {
  const receipts = input.receipts.listByTask(input.taskId);
  const acceptedAttemptIds = input.acceptedAttemptIds ?? new Set<string>();
  const isAccepted = (attemptId: string) => acceptedAttemptIds.has(attemptId);
  const sources = input.subtasks.map(subtask => {
    const receipt = receipts.find(item =>
      item.subtaskId === subtask.id && item.generationId === input.generationId
      && (item.terminalState === 'completed' || isAccepted(item.attemptId)));
    if (!receipt) return null;
    const safe = resolveSafeResult({
      accountId: input.accountId, receipt,
      findObject: id => input.results.findObject(id),
      findReceipt: id => input.receipts.findByAttemptId(id),
    });
    if (!safe) return null;
    // Result objects are immutable. A metadata-only contract correction can
    // certify its source's safe bytes without rewriting their original
    // `partial` marker. The completed correction receipt and the verified
    // source identity above are the certification, not that historical marker.
    const certifiedSource = receipt.attemptKind === 'contract_correction'
      && safe.sourceAttemptId === safe.resultOwnerAttemptId;
    if (safe.object.completeness !== 'complete' && !certifiedSource && !isAccepted(receipt.attemptId)) return null;
    const content = input.results.readRange(safe.object.resultId, 0, safe.object.byteLength).content;
    return { title: subtask.title, content, subtask, safe };
  });
  if (sources.length === 0 || sources.some(source => !source)) return null;
  return sources.filter(source => source !== null);
}
