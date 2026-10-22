import { describe, expect, it } from 'vitest';
import { resolveSafeResult, type SafeResultReceipt, type SafeResultObject } from '../../src/task/safe-result-identity.js';

const primary: SafeResultReceipt = { attemptId: 'primary', taskId: 'task', subtaskId: 'subtask',
  generationId: 'generation', graphRevision: 1, attemptKind: 'primary', sourceAttemptId: null,
  parsing: { resultObjects: { safeProjectionId: 'safe' } } };
const correction: SafeResultReceipt = { ...primary, attemptId: 'correction', attemptKind: 'contract_correction', sourceAttemptId: 'primary' };
const object: SafeResultObject = { resultId: 'safe', accountId: 'account', taskId: 'task', sourceSubtaskId: 'subtask',
  generationId: 'generation', attemptId: 'primary', kind: 'safe_projection', byteLength: 42, completeness: 'partial' };
function resolve(receipt = correction, result = object, source: SafeResultReceipt | null = primary) {
  return resolveSafeResult({ accountId: 'account', receipt, findObject: id => id === result.resultId ? result : null,
    findReceipt: id => id === source?.attemptId ? source : null });
}
describe('safe result ownership', () => {
  it('accepts primary and correction reuse with distinct decision/result owners', () => {
    expect(resolve(primary)?.resultOwnerAttemptId).toBe('primary');
    expect(resolve()).toMatchObject({ decisionAttemptId: 'correction', resultObjectId: 'safe', resultOwnerAttemptId: 'primary', sourceAttemptId: 'primary' });
  });
  it.each(['accountId', 'taskId', 'sourceSubtaskId', 'generationId', 'attemptId', 'kind', 'resultId'] as const)(
    'rejects mismatched %s', key => expect(resolve(correction, { ...object, [key]: 'other' })).toBeNull());
  it('requires source receipt to reference exactly the same object in the same graph', () => {
    expect(resolve(correction, object, null)).toBeNull();
    expect(resolve(correction, object, { ...primary, parsing: { resultObjects: { safeProjectionId: 'other' } } })).toBeNull();
    expect(resolve(correction, object, { ...primary, graphRevision: 2 })).toBeNull();
  });
  it('never resolves raw, empty or incomplete objects', () => {
    expect(resolve(correction, { ...object, kind: 'raw_attempt_output' })).toBeNull();
    expect(resolve(correction, { ...object, byteLength: 0 })).toBeNull();
    expect(resolve(correction, { ...object, completeness: 'incomplete' })).toBeNull();
  });
});
