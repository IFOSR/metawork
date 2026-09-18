/**
 * Per-message attachment budget for the Web Composer.
 *
 * Mirrors `src/gateway/attachment-budget.ts`. The Server remains the enforcing
 * side; these bounds exist so the Browser rejects a file before spending an
 * upload, and refuses to add a file that could never be sent.
 */

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES_PER_MESSAGE = 500 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 32;

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

export function evaluateAttachmentCount(count: number): AttachmentBudgetViolation | null {
  if (count <= MAX_ATTACHMENTS_PER_MESSAGE) return null;
  return {
    code: 'attachment_count_exceeded',
    message: `单条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件（当前 ${count} 个）。`,
  };
}

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
