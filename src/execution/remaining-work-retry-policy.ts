/**
 * Task Runtime remaining-work retry policy (ADR-0055 D5).
 *
 * Formerly the inline `task_remaining_work_retry_requested` branch of
 * the retired policy decider. An explicit user retry authorizes only the
 * delivery and service work that already exists; it never re-authorizes Executor
 * work, so an unsafe or incomplete reuse is refused instead of guessed.
 */
import type { ControlDecision, ControlEvent, ControlSnapshot } from '../control/control-contracts.js';
import { decision } from '../control/control-contracts.js';

/**
 * Authorizes reuse of already delivered remaining work instead of re-planning.
 */
export function decideRemainingWorkRetry(
  event: Extract<ControlEvent, { type: 'task_remaining_work_retry_requested' }>,
  snapshot: Extract<ControlSnapshot, { type: 'remaining_work_retry' }>,
): ControlDecision {
  const facts = snapshot;
  if (facts.task?.id !== event.taskId || facts.task?.status !== 'failed'
    || !facts.safeToRetry || !facts.remaining || facts.remaining.sourceVersion !== event.expectedVersion
    || facts.remaining.sourceTaskId !== event.taskId
    || (!facts.remaining.startService && facts.remaining.publicationIds.length === 0)) {
    return decision(event, { type: 'reject_request' }, '未完成工作缺少可安全复用的成果，请基于原任务重新规划。');
  }
  return decision(event, { type: 'retry_remaining_work',
    taskId: `task_retry_${facts.remaining.sourceTaskId}_${facts.remaining.sourceVersion}`,
    remaining: facts.remaining }, 'explicit retry authorizes only remaining delivery and service work');
}
