import { describe, expect, it } from 'vitest';
import {
  evaluateAttachmentBudget,
  evaluateAttachmentCount,
  formatByteSize,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from '../../src/gateway/attachment-budget.js';

describe('attachment budget', () => {
  it('uses one authoritative single-file bound', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_ATTACHMENT_TOTAL_BYTES_PER_MESSAGE).toBe(500 * 1024 * 1024);
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(32);
  });

  it('admits a single attachment exactly at the single-file bound', () => {
    expect(evaluateAttachmentBudget([{ name: 'exact.xlsx', size: MAX_ATTACHMENT_BYTES }])).toBeNull();
  });

  it('admits a full 32-attachment message that stays inside the total bound', () => {
    const entries = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) => ({
      name: `f${index}.bin`,
      size: 15 * 1024 * 1024,
    }));
    expect(evaluateAttachmentBudget(entries)).toBeNull();
  });

  it('rejects a single attachment above the single-file bound', () => {
    const violation = evaluateAttachmentBudget([
      { name: '菜单.xlsx', size: MAX_ATTACHMENT_BYTES + 1 },
    ]);
    expect(violation).toMatchObject({ code: 'attachment_too_large' });
    expect(violation?.message).toContain('菜单.xlsx');
    expect(violation?.message).toContain('100.0 MiB');
  });

  it('rejects a message whose attachment total exceeds 500 MiB', () => {
    const violation = evaluateAttachmentBudget(
      Array.from({ length: 6 }, (_, index) => (
        { name: `part-${index}.bin`, size: 90 * 1024 * 1024 }
      )),
    );
    expect(violation).toMatchObject({ code: 'attachment_total_too_large' });
    expect(violation?.message).toContain('540.0 MiB');
    expect(violation?.message).toContain('500.0 MiB');
  });

  it('rejects more than 32 attachments even when every file is small', () => {
    const entries = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, index) => ({
      name: `f${index}`,
      size: 1,
    }));
    expect(evaluateAttachmentBudget(entries)).toMatchObject({
      code: 'attachment_count_exceeded',
    });
    expect(evaluateAttachmentCount(MAX_ATTACHMENTS_PER_MESSAGE)).toBeNull();
  });

  it('formats sizes without depending on the caller', () => {
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(1024)).toBe('1.0 KiB');
    expect(formatByteSize(500 * 1024 * 1024)).toBe('500.0 MiB');
  });
});
