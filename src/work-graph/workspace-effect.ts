import type { WorkGraphSubtask } from './types.js';

type CandidateNode = Pick<WorkGraphSubtask, 'id' | 'workspaceEffect' | 'deliveryKind' | 'fileOutputs'>;
type CandidateGraph = ReadonlyArray<Pick<WorkGraphSubtask, 'dependencies'>>;

/** The only two access facts a Subtask can have against the Conversation Worktree. */
export type WorkspaceWriteEffect = 'read_only' | 'write';

/**
 * A node whose declared work cannot change business files: it delivers a report,
 * asks for no downloadable file, and consumes only text handoffs.
 *
 * This is a shape test, not a verdict about execution access.
 */
export function isSharedReadCandidate(node: CandidateNode, graph: CandidateGraph): boolean {
  return node.deliveryKind === 'report'
    && Array.isArray(node.fileOutputs) && node.fileOutputs.length === 0
    && graph.every(candidate => candidate.dependencies.every(edge =>
      edge.fromSubtaskId !== node.id || edge.requiredItems.every(item => item.type === 'text')));
}

/**
 * The single owner rule for "may this node change business files?".
 *
 * Kernel admission, the Workspace write lease and the Attempt launch all read
 * this one answer, so a read-only authorization can never be executed as a write
 * (convergence review B-01). A node whose declared work cannot produce business
 * writes therefore runs as a shared reader even when the Planner omitted
 * `workspaceEffect`: an omitted or `unknown` effect is not a write grant. An
 * explicit `write`, a non-report delivery, any declared file output or an
 * artifact handoff keeps the exclusive write path.
 */
export function resolveWorkspaceWriteEffect(node: CandidateNode, graph: CandidateGraph): WorkspaceWriteEffect {
  if (node.workspaceEffect === 'write') return 'write';
  if (!isSharedReadCandidate(node, graph)) return 'write';
  return 'read_only';
}

/** True when the node needs the exclusive Workspace write lease. */
export function writesWorkspace(node: CandidateNode, graph: CandidateGraph): boolean {
  return resolveWorkspaceWriteEffect(node, graph) === 'write';
}

/** Read access for every node the shared read lease can host. */
export function supportsSharedWorkspaceRead(node: CandidateNode, graph: CandidateGraph): boolean {
  return resolveWorkspaceWriteEffect(node, graph) === 'read_only';
}
