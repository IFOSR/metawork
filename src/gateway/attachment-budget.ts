import { MAX_ATTACHMENT_BYTES } from './attachment-store-port.js';

/**
 * Per-message attachment budget.
 *
 * The store owns the single-file upload contract; this module owns the
 * per-message budget that the Client surfaces pre-check and the Gateway
 * enforces before a user message is admitted. Planner and Executor never see
 * the budget, only the already-admitted attachment references.
 */

export const MAX_ATTACHMENTS_PER_MESSAGE = 32;
export const MAX_ATTACHMENT_TOTAL_BYTES_PER_MESSAGE = 500 * 1024 * 1024;

export { MAX_ATTACHMENT_BYTES };

export type AttachmentBudgetViolationCode =
  | 'attachment_count_exceeded'
  | 'attachment_too_large'
  | 'attachment_total_too_large';

export interface AttachmentBudgetViolation {
  readonly code: AttachmentBudgetViolationCode;
  readonly message: string;
}

export interface AttachmentBudgetEntry {
  readonly name: string;
  readonly size: number;
}

export function formatByteSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Returns the violation for the attachment-count rule, or null when within
 * budget. Exposed separately so a caller that cannot resolve metadata yet (or
 * has no store bound) can still enforce the count rule with one definition.
 */
export function evaluateAttachmentCount(count: number): AttachmentBudgetViolation | null {
  if (count <= MAX_ATTACHMENTS_PER_MESSAGE) return null;
  return {
    code: 'attachment_count_exceeded',
    message: `单条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件（当前 ${count} 个）。`,
  };
}

/**
 * Returns the first violated rule for one message's attachment set, or null
 * when the set is within budget. Pure so the Web pre-check and the Gateway
 * admission check cannot drift apart in behavior.
 */
export function evaluateAttachmentBudget(
  entries: readonly AttachmentBudgetEntry[],
): AttachmentBudgetViolation | null {
  const countViolation = evaluateAttachmentCount(entries.length);
  if (countViolation) return countViolation;
  const oversized = entries.find(entry => entry.size > MAX_ATTACHMENT_BYTES);
  if (oversized) {
    return {
      code: 'attachment_too_large',
      message: `附件「${oversized.name}」为 ${formatByteSize(oversized.size)}，超过单个附件上限 ${formatByteSize(MAX_ATTACHMENT_BYTES)}。`,
    };
  }
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total > MAX_ATTACHMENT_TOTAL_BYTES_PER_MESSAGE) {
    return {
      code: 'attachment_total_too_large',
      message: `单条消息的附件合计为 ${formatByteSize(total)}，超过上限 ${formatByteSize(MAX_ATTACHMENT_TOTAL_BYTES_PER_MESSAGE)}。`,
    };
  }
  return null;
}
