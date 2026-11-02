import type { WorkGraphSubtask } from './types.js';

type CandidateNode = Pick<WorkGraphSubtask, 'id' | 'workspaceEffect' | 'deliveryKind' | 'fileOutputs'>;
type CandidateGraph = ReadonlyArray<Pick<WorkGraphSubtask, 'dependencies'>>;

/**
 * A node whose work cannot change business files: it delivers a report, asks
 * for no downloadable file, and consumes only text handoffs.
 *
 * This is a shape test, not a verdict. It says the node *could* run beside other
 * readers; only an explicit `read_only` declaration actually grants that.
 */
export function isSharedReadCandidate(node: CandidateNode, graph: CandidateGraph): boolean {
  return node.deliveryKind === 'report'
    && Array.isArray(node.fileOutputs) && node.fileOutputs.length === 0
    && graph.every(candidate => candidate.dependencies.every(edge =>
      edge.fromSubtaskId !== node.id || edge.requiredItems.every(item => item.type === 'text')));
}

/** Only explicit, text-only readers participate in shared Workspace access. */
export function supportsSharedWorkspaceRead(node: CandidateNode, graph: CandidateGraph): boolean {
  return node.workspaceEffect === 'read_only' && isSharedReadCandidate(node, graph);
}
