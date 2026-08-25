import type { WorkGraphSubtask } from './types.js';

export function buildCanonicalSubtaskIdentityMap(
  taskId: string,
  graphRevision: number,
  proposals: readonly Pick<WorkGraphSubtask, 'id'>[],
): ReadonlyMap<string, string> {
  const used = new Set<string>();
  const identities = new Map<string, string>();
  for (const proposal of proposals) {
    identities.set(
      proposal.id,
      canonicalSubtaskId(taskId, graphRevision, proposal.id, used),
    );
  }
  return identities;
}

function canonicalSubtaskId(
  taskId: string,
  graphRevision: number,
  proposalId: string,
  used: Set<string>,
): string {
  const base = normalizeSubtaskId(taskId, graphRevision, proposalId);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  for (;;) {
    const candidate = `${base}_${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    index += 1;
  }
}

function normalizeSubtaskId(taskId: string, graphRevision: number, proposalId: string): string {
  if (proposalId.startsWith(`${taskId}_r${graphRevision}_`)) return proposalId;
  const safeId = proposalId
    .replace(/[^a-zA-Z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'subtask_execute';
  return `${taskId}_r${graphRevision}_${safeId}`;
}
