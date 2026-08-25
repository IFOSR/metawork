import { describe, expect, it } from 'vitest';
import {
  mergeConflictObservationId,
  parseMergeRepairReport,
} from '../../src/execution/merge-repair-protocol.js';

describe('merge repair protocol', () => {
  it('rejects the exact generic completion trailer emitted by the historical repair attempt', () => {
    const response = [
      '已解决授权路径的合并冲突。',
      '',
      '---METACLAW-MERGE-REPAIR---',
      JSON.stringify({
        evidence: ['11 个授权冲突路径已验证'],
        noChangeReason: null,
      }),
    ].join('\n');

    expect(() => parseMergeRepairReport(response)).toThrow(
      'merge repair trailer protocol is invalid',
    );
  });

  it('keys one conflict observation by publication and consumed repair budget', () => {
    expect(mergeConflictObservationId('publication-1', 1)).toBe(
      mergeConflictObservationId('publication-1', 1),
    );
    expect(mergeConflictObservationId('publication-1', 1)).not.toBe(
      mergeConflictObservationId('publication-1', 2),
    );
  });
});
