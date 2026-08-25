import { createHash } from 'node:crypto';

export const MERGE_REPAIR_MARKER = '---METACLAW-MERGE-REPAIR---' as const;
export const MERGE_REPAIR_PROTOCOL = 'metaclaw:merge-repair:v1' as const;

export function mergeRepairReportExample(allowedPaths: readonly string[]): string {
  return JSON.stringify({
    protocol: MERGE_REPAIR_PROTOCOL,
    resolvedPaths: [...allowedPaths],
    verification: {
      summary: '<verification summary>',
    },
  });
}

export function parseMergeRepairReport(rawResponse: string): {
  resolvedPaths: string[];
  verificationSummary: string;
} {
  const markerIndex = rawResponse.lastIndexOf(MERGE_REPAIR_MARKER);
  if (markerIndex < 0 || rawResponse.indexOf(MERGE_REPAIR_MARKER) !== markerIndex) {
    throw new Error('merge repair response must contain exactly one protocol trailer');
  }
  const payloadText = rawResponse.slice(markerIndex + MERGE_REPAIR_MARKER.length).trim();
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new Error('merge repair trailer is not valid JSON');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('merge repair trailer must be an object');
  }
  const record = payload as Record<string, unknown>;
  if (record.protocol !== MERGE_REPAIR_PROTOCOL) {
    throw new Error('merge repair trailer protocol is invalid');
  }
  if (
    !Array.isArray(record.resolvedPaths)
    || record.resolvedPaths.some(path => typeof path !== 'string' || path.length === 0)
  ) {
    throw new Error('merge repair trailer resolvedPaths must contain non-empty strings');
  }
  const verification = record.verification;
  if (!verification || typeof verification !== 'object') {
    throw new Error('merge repair trailer verification is required');
  }
  const summary = (verification as Record<string, unknown>).summary;
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new Error('merge repair verification.summary must be non-empty');
  }
  return {
    resolvedPaths: record.resolvedPaths as string[],
    verificationSummary: summary.trim(),
  };
}

export function mergeConflictObservationId(
  publicationId: string,
  repairAttemptsUsed: number,
): string {
  const identity = createHash('sha256')
    .update(`${publicationId}\u0000${repairAttemptsUsed}`)
    .digest('hex');
  return `event_merge_conflict_${identity}`;
}
