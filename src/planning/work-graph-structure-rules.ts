export type WorkGraphViolationCode =
  | 'dependency_cycle'
  | 'duplicate_dependency'
  | 'duplicate_subtask_id'
  | 'empty_subtask_id'
  | 'empty_work_graph'
  | 'mergeable_same_agent_chain'
  | 'missing_entry_node'
  | 'same_layer_preferred_conflict'
  | 'self_dependency'
  | 'unknown_dependency';

export interface WorkGraphViolation {
  code: WorkGraphViolationCode;
  subtaskIds: string[];
  message: string;
}

interface WorkGraphStructureInput {
  subtasks: Array<{
    id: string;
    dependsOn: string[];
    preferredAgentClassList: string[];
  }>;
}

export function validateWorkGraphStructure(graph: WorkGraphStructureInput): WorkGraphViolation[] {
  const identityViolations: WorkGraphViolation[] = [];
  if (graph.subtasks.length === 0) {
    identityViolations.push({ code: 'empty_work_graph', subtaskIds: [], message: 'work graph has no subtasks' });
  }
  const seenIds = new Set<string>();
  for (const subtask of graph.subtasks) {
    if (!subtask.id.trim()) {
      identityViolations.push({ code: 'empty_subtask_id', subtaskIds: [], message: 'work graph contains an empty subtask id' });
    } else if (seenIds.has(subtask.id)) {
      identityViolations.push({
        code: 'duplicate_subtask_id',
        subtaskIds: [subtask.id],
        message: `work graph repeats subtask id ${subtask.id}`,
      });
    }
    seenIds.add(subtask.id);
  }
  const subtasksById = new Map(graph.subtasks.map(subtask => [subtask.id, subtask]));
  const dependencyGraph = new Map<string, string[]>();
  const dependencyViolations: WorkGraphViolation[] = [];
  for (const subtask of graph.subtasks) {
    const seen = new Set<string>();
    const knownDependencies: string[] = [];
    for (const dependencyId of subtask.dependsOn) {
      if (seen.has(dependencyId)) {
        dependencyViolations.push({
          code: 'duplicate_dependency',
          subtaskIds: [subtask.id, dependencyId],
          message: `subtask ${subtask.id} repeats dependency ${dependencyId}`,
        });
        continue;
      }
      seen.add(dependencyId);
      if (dependencyId === subtask.id) {
        dependencyViolations.push({
          code: 'self_dependency',
          subtaskIds: [subtask.id],
          message: `subtask ${subtask.id} depends on itself`,
        });
        continue;
      }
      if (!subtasksById.has(dependencyId)) {
        dependencyViolations.push({
          code: 'unknown_dependency',
          subtaskIds: [subtask.id, dependencyId],
          message: `subtask ${subtask.id} depends on unknown subtask ${dependencyId}`,
        });
        continue;
      }
      knownDependencies.push(dependencyId);
    }
    dependencyGraph.set(subtask.id, knownDependencies);
  }

  const children = new Map<string, string[]>();
  for (const subtask of graph.subtasks) {
    children.set(subtask.id, []);
  }
  for (const subtask of graph.subtasks) {
    for (const dependencyId of subtask.dependsOn) {
      children.get(dependencyId)?.push(subtask.id);
    }
  }

  const violations: WorkGraphViolation[] = [...identityViolations, ...dependencyViolations];
  if (graph.subtasks.length > 0 && [...dependencyGraph.values()].every(dependencies => dependencies.length > 0)) {
    violations.push({
      code: 'missing_entry_node',
      subtaskIds: [],
      message: 'work graph has no dependency-free entry subtask',
    });
  }
  if (containsCycle(dependencyGraph)) {
    violations.push({
      code: 'dependency_cycle',
      subtaskIds: [],
      message: 'work graph contains a dependency cycle',
    });
  }
  for (const downstream of graph.subtasks) {
    if (downstream.dependsOn.length !== 1) continue;
    const upstreamId = downstream.dependsOn[0]!;
    if (children.get(upstreamId)?.length !== 1) continue;
    const upstream = subtasksById.get(upstreamId);
    const preferred = upstream?.preferredAgentClassList[0];
    if (!preferred || downstream.preferredAgentClassList[0] !== preferred) continue;
    violations.push({
      code: 'mergeable_same_agent_chain',
      subtaskIds: [upstreamId, downstream.id],
      message: `subtasks ${upstreamId} -> ${downstream.id} form a mergeable ${preferred} single chain`,
    });
  }

  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const deriveLayer = (subtaskId: string): number => {
    const cached = layers.get(subtaskId);
    if (cached !== undefined) return cached;
    if (visiting.has(subtaskId)) return 0;
    visiting.add(subtaskId);
    const subtask = subtasksById.get(subtaskId);
    const dependencyLayers = (subtask?.dependsOn ?? [])
      .filter(dependencyId => subtasksById.has(dependencyId))
      .map(deriveLayer);
    visiting.delete(subtaskId);
    const layer = dependencyLayers.length === 0 ? 0 : Math.max(...dependencyLayers) + 1;
    layers.set(subtaskId, layer);
    return layer;
  };
  const ownershipByLayer = new Map<string, string[]>();
  for (const subtask of graph.subtasks) {
    const preferred = subtask.preferredAgentClassList[0];
    if (!preferred) continue;
    const layer = deriveLayer(subtask.id);
    const key = `${layer}\u0000${preferred}`;
    ownershipByLayer.set(key, [...(ownershipByLayer.get(key) ?? []), subtask.id]);
  }
  for (const [key, subtaskIds] of ownershipByLayer) {
    if (subtaskIds.length < 2) continue;
    const [layer, preferred] = key.split('\u0000');
    const sortedIds = [...subtaskIds].sort((left, right) => left.localeCompare(right));
    violations.push({
      code: 'same_layer_preferred_conflict',
      subtaskIds: sortedIds,
      message: `derived layer ${layer} assigns preferred AgentClass ${preferred} more than once: ${sortedIds.join(', ')}`,
    });
  }

  return violations.sort(compareViolations);
}

function compareViolations(left: WorkGraphViolation, right: WorkGraphViolation): number {
  return left.code.localeCompare(right.code)
    || left.subtaskIds.join('\u0000').localeCompare(right.subtaskIds.join('\u0000'));
}

function containsCycle(graph: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((graph.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...graph.keys()].some(visit);
}
