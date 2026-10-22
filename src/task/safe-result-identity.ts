/** Pure, fail-closed receipt/result identity resolution. No ownership is inferred from timestamps. */
export interface SafeResultReceipt {
  attemptId: string;
  taskId: string;
  subtaskId: string;
  generationId: string;
  graphRevision?: number;
  attemptKind?: string;
  sourceAttemptId?: string | null;
  parsing: Record<string, unknown>;
}

export interface SafeResultObject {
  resultId: string;
  accountId: string;
  taskId: string;
  generationId: string;
  sourceSubtaskId: string;
  attemptId: string;
  kind: string;
  byteLength: number;
  completeness: 'complete' | 'partial' | 'incomplete';
}

export interface PendingResultIdentity {
  taskId: string;
  generationId: string;
  graphRevision: number;
  subtaskId: string;
  attemptId: string;
  resultId: string;
}

export function safeProjectionId(receipt: SafeResultReceipt): string | null {
  const refs = receipt.parsing?.resultObjects;
  if (!refs || typeof refs !== 'object') return null;
  const id = (refs as Record<string, unknown>).safeProjectionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function resolveSafeResult<T extends SafeResultObject>(input: {
  accountId: string;
  receipt: SafeResultReceipt;
  findObject(id: string): T | null;
  findReceipt(id: string): SafeResultReceipt | null;
}): { decisionAttemptId: string; resultObjectId: string; resultOwnerAttemptId: string;
  sourceAttemptId: string | null; object: T } | null {
  const receipt = input.receipt;
  const id = safeProjectionId(receipt);
  const object = id ? input.findObject(id) : null;
  if (!object || object.kind !== 'safe_projection' || object.byteLength <= 0
    || object.completeness === 'incomplete' || object.accountId !== input.accountId
    || object.taskId !== receipt.taskId || object.sourceSubtaskId !== receipt.subtaskId
    || object.generationId !== receipt.generationId) return null;
  const sourceId = receipt.attemptKind === 'contract_correction' ? receipt.sourceAttemptId ?? null : null;
  if (object.attemptId !== receipt.attemptId) {
    if (!sourceId || object.attemptId !== sourceId) return null;
    const source = input.findReceipt(sourceId);
    if (!source || source.taskId !== receipt.taskId || source.subtaskId !== receipt.subtaskId
      || source.generationId !== receipt.generationId || source.graphRevision !== receipt.graphRevision
      || safeProjectionId(source) !== object.resultId) return null;
  }
  return { decisionAttemptId: receipt.attemptId, resultObjectId: object.resultId,
    resultOwnerAttemptId: object.attemptId, sourceAttemptId: sourceId, object };
}
