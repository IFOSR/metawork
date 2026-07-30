import type { WorkGraphSubtask } from './types.js';

export type WorkGraphRuntimeStatus =
  | 'ready'
  | 'running'
  | 'awaiting_integration'
  | 'awaiting_decision'
  | 'blocked'
  | 'done'
  | 'cancelled';

export interface WorkGraphRuntimeFact {
  subtaskId: string;
  status: WorkGraphRuntimeStatus;
  firstDispatchOrder: number | null;
  hasPendingOrActiveAttempt: boolean;
}

type FrontierSubtask = Pick<WorkGraphSubtask, 'id' | 'dependencies'>;

/**
 * Derive the currently runnable Subtask ids without persisting an execution layer.
 * Invalid or incomplete graph facts fail closed by excluding the affected node.
 */
export function deriveRunnableFrontier(
  graph: { subtasks: readonly FrontierSubtask[] },
  facts: readonly WorkGraphRuntimeFact[],
): string[] {
  const subtasksById = new Map(graph.subtasks.map(subtask => [subtask.id, subtask]));
  const factsById = new Map(facts.map(fact => [fact.subtaskId, fact]));
  const layers = deriveTopologyLayers(subtasksById);

  return graph.subtasks
    .filter(subtask => isRunnable(subtask, factsById))
    .sort((left, right) => {
      const layerDifference = (layers.get(left.id) ?? Number.MAX_SAFE_INTEGER)
        - (layers.get(right.id) ?? Number.MAX_SAFE_INTEGER);
      if (layerDifference !== 0) return layerDifference;
      const leftOrder = factsById.get(left.id)?.firstDispatchOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = factsById.get(right.id)?.firstDispatchOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.id.localeCompare(right.id);
    })
    .map(subtask => subtask.id);
}

function isRunnable(
  subtask: FrontierSubtask,
  factsById: ReadonlyMap<string, WorkGraphRuntimeFact>,
): boolean {
  const fact = factsById.get(subtask.id);
  if (!fact || fact.status !== 'ready' || fact.hasPendingOrActiveAttempt) return false;
  return subtask.dependencies.every(dependency => factsById.get(dependency.fromSubtaskId)?.status === 'done');
}

function deriveTopologyLayers(
  subtasksById: ReadonlyMap<string, FrontierSubtask>,
): Map<string, number> {
  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const derive = (subtaskId: string): number => {
    const cached = layers.get(subtaskId);
    if (cached !== undefined) return cached;
    if (visiting.has(subtaskId)) return Number.MAX_SAFE_INTEGER;
    const subtask = subtasksById.get(subtaskId);
    if (!subtask) return Number.MAX_SAFE_INTEGER;
    visiting.add(subtaskId);
    const dependencyLayers = subtask.dependencies.map(dependency => derive(dependency.fromSubtaskId));
    visiting.delete(subtaskId);
    const layer = dependencyLayers.length === 0
      ? 0
      : Math.max(...dependencyLayers) + 1;
    layers.set(subtaskId, layer);
    return layer;
  };

  for (const subtaskId of subtasksById.keys()) derive(subtaskId);
  return layers;
}
