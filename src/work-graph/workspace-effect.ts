import type { WorkGraphSubtask } from './types.js';

/** Only explicit, text-only readers participate in shared Workspace access. */
export function supportsSharedWorkspaceRead(
  node: Pick<WorkGraphSubtask, 'id' | 'workspaceEffect' | 'deliveryKind' | 'fileOutputs'>,
  graph: ReadonlyArray<Pick<WorkGraphSubtask, 'dependencies'>>,
): boolean {
  return node.workspaceEffect === 'read_only'
    && node.deliveryKind === 'report'
    && Array.isArray(node.fileOutputs) && node.fileOutputs.length === 0
    && graph.every(candidate => candidate.dependencies.every(edge =>
      edge.fromSubtaskId !== node.id || edge.requiredItems.every(item => item.type === 'text')));
}
