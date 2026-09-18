import { describe, expect, it } from 'vitest';
import {
  evaluateAttachmentBudget,
  evaluateAttachmentCount,
  formatByteSize,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from '../../web/src/attachment-limits.js';

describe('Web attachment budget', () => {
  it('keeps the single-file and per-message bounds in sync with the Server contract', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_ATTACHMENT_TOTAL_BYTES_PER_MESSAGE).toBe(500 * 1024 * 1024);
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(32);
  });

  it('accepts a selection within every bound', () => {
    expect(evaluateAttachmentBudget([
      { name: 'a.xlsx', size: 80 * 1024 * 1024 },
      { name: 'b.docx', size: 20 * 1024 * 1024 },
    ])).toBeNull();
  });

  it('rejects a single file above 100 MiB with its name and size', () => {
    const violation = evaluateAttachmentBudget([
      { name: '菜单.xlsx', size: MAX_ATTACHMENT_BYTES + 1 },
    ]);
    expect(violation?.code).toBe('attachment_too_large');
    expect(violation?.message).toContain('菜单.xlsx');
    expect(violation?.message).toContain('100.0 MiB');
  });

  it('rejects a selection above 500 MiB in total', () => {
    const chunk = 100 * 1024 * 1024;
    const violation = evaluateAttachmentBudget([
      { name: 'a', size: chunk },
      { name: 'b', size: chunk },
      { name: 'c', size: chunk },
      { name: 'd', size: chunk },
      { name: 'e', size: chunk },
      { name: 'f', size: chunk },
    ]);
    expect(violation?.code).toBe('attachment_total_too_large');
    expect(violation?.message).toContain('600.0 MiB');
  });

  it('rejects more than 32 attachments before the size rules', () => {
    const entries = Array.from({ length: 33 }, (_, index) => ({
      name: `f${index}`,
      size: 1,
    }));
    expect(evaluateAttachmentBudget(entries)?.code).toBe('attachment_count_exceeded');
    expect(evaluateAttachmentCount(32)).toBeNull();
    expect(evaluateAttachmentCount(33)?.code).toBe('attachment_count_exceeded');
  });

  it('formats byte sizes for the user-facing messages', () => {
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(2048)).toBe('2.0 KiB');
    expect(formatByteSize(100 * 1024 * 1024)).toBe('100.0 MiB');
  });
});
