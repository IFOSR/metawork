import type { ContextRef, WorkGraphProposal, WorkGraphSubtask } from './types.js';

export const WORK_GRAPH_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export type WorkGraphViolationCode =
  | 'acceptance_count_invalid'
  | 'dependency_cycle'
  | 'dependency_items_count_invalid'
  | 'description_invalid'
  | 'duplicate_acceptance_key'
  | 'duplicate_context_ref'
  | 'duplicate_dependency'
  | 'duplicate_dependency_item_key'
  | 'duplicate_subtask_id'
  | 'empty_subtask_id'
  | 'empty_work_graph'
  | 'evidence_requirements_count_invalid'
  | 'invalid_key'
  | 'mergeable_same_agent_chain'
  | 'missing_entry_node'
  | 'same_layer_preferred_conflict'
  | 'self_dependency'
  | 'too_many_context_refs'
  | 'unknown_dependency';

export interface WorkGraphViolation {
  code: WorkGraphViolationCode;
  subtaskIds: string[];
  path: string;
  message: string;
}

/** Pure v4 structural and contract validation shared by Planner, Kernel and Runtime. */
export function validateWorkGraph(graph: Pick<WorkGraphProposal, 'subtasks'>): WorkGraphViolation[] {
  const violations: WorkGraphViolation[] = [];
  if (graph.subtasks.length === 0) {
    violations.push(violation('empty_work_graph', [], 'subtasks', 'work graph has no subtasks'));
  }

  const subtasksById = new Map<string, WorkGraphSubtask>();
  for (const [index, subtask] of graph.subtasks.entries()) {
    const path = `subtasks.${index}`;
    if (!subtask.id.trim()) {
      violations.push(violation('empty_subtask_id', [], `${path}.id`, 'work graph contains an empty subtask id'));
    } else if (subtasksById.has(subtask.id)) {
      violations.push(violation('duplicate_subtask_id', [subtask.id], `${path}.id`, `work graph repeats subtask id ${subtask.id}`));
    } else {
      subtasksById.set(subtask.id, subtask);
    }
    validateSubtaskContract(subtask, index, violations);
  }

  const dependencyGraph = new Map<string, string[]>();
  for (const [index, subtask] of graph.subtasks.entries()) {
    const known: string[] = [];
    const seen = new Set<string>();
    for (const [dependencyIndex, dependency] of subtask.dependencies.entries()) {
      const path = `subtasks.${index}.dependencies.${dependencyIndex}.fromSubtaskId`;
      const dependencyId = dependency.fromSubtaskId;
      if (seen.has(dependencyId)) {
        violations.push(violation('duplicate_dependency', [subtask.id, dependencyId], path, `subtask ${subtask.id} repeats dependency ${dependencyId}`));
        continue;
      }
      seen.add(dependencyId);
      if (dependencyId === subtask.id) {
        violations.push(violation('self_dependency', [subtask.id], path, `subtask ${subtask.id} depends on itself`));
      } else if (!subtasksById.has(dependencyId)) {
        violations.push(violation('unknown_dependency', [subtask.id, dependencyId], path, `subtask ${subtask.id} depends on unknown subtask ${dependencyId}`));
      } else {
        known.push(dependencyId);
      }
    }
    dependencyGraph.set(subtask.id, known);
  }

  if (graph.subtasks.length > 0 && graph.subtasks.every(subtask => subtask.dependencies.length > 0)) {
    violations.push(violation('missing_entry_node', [], 'subtasks', 'work graph has no dependency-free entry subtask'));
  }
  if (containsCycle(dependencyGraph)) {
    violations.push(violation('dependency_cycle', [], 'subtasks', 'work graph contains a dependency cycle'));
  }

  const children = new Map<string, string[]>();
  for (const subtask of graph.subtasks) children.set(subtask.id, []);
  for (const subtask of graph.subtasks) {
    for (const dependency of subtask.dependencies) {
      children.get(dependency.fromSubtaskId)?.push(subtask.id);
    }
  }
  for (const [index, downstream] of graph.subtasks.entries()) {
    if (downstream.dependencies.length !== 1) continue;
    const upstreamId = downstream.dependencies[0]!.fromSubtaskId;
    if (children.get(upstreamId)?.length !== 1) continue;
    const upstream = subtasksById.get(upstreamId);
    const preferred = upstream?.preferredAgentClassList[0];
    if (!preferred || downstream.preferredAgentClassList[0] !== preferred) continue;
    violations.push(violation(
      'mergeable_same_agent_chain',
      [upstreamId, downstream.id],
      `subtasks.${index}.dependencies.0`,
      `subtasks ${upstreamId} -> ${downstream.id} form a mergeable ${preferred} single chain`,
    ));
  }

  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const deriveLayer = (subtaskId: string): number => {
    const cached = layers.get(subtaskId);
    if (cached !== undefined) return cached;
    if (visiting.has(subtaskId)) return 0;
    visiting.add(subtaskId);
    const subtask = subtasksById.get(subtaskId);
    const dependencyLayers = (subtask?.dependencies ?? [])
      .map(dependency => dependency.fromSubtaskId)
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
    violations.push(violation(
      'same_layer_preferred_conflict',
      sortedIds,
      'subtasks',
      `derived layer ${layer} assigns preferred AgentClass ${preferred} more than once: ${sortedIds.join(', ')}`,
    ));
  }
  return violations.sort(compareViolations);
}

function validateSubtaskContract(
  subtask: WorkGraphSubtask,
  index: number,
  violations: WorkGraphViolation[],
): void {
  const base = `subtasks.${index}`;
  if (subtask.contextRefs.length > 12) {
    violations.push(violation('too_many_context_refs', [subtask.id], `${base}.contextRefs`, `subtask ${subtask.id} has more than 12 context refs`));
  }
  const contextKeys = new Set<string>();
  for (const [refIndex, ref] of subtask.contextRefs.entries()) {
    const key = contextRefKey(ref);
    if (contextKeys.has(key)) {
      violations.push(violation('duplicate_context_ref', [subtask.id], `${base}.contextRefs.${refIndex}`, `subtask ${subtask.id} repeats context ref ${key}`));
    }
    contextKeys.add(key);
  }

  for (const [dependencyIndex, dependency] of subtask.dependencies.entries()) {
    const path = `${base}.dependencies.${dependencyIndex}.requiredItems`;
    if (dependency.requiredItems.length < 1 || dependency.requiredItems.length > 12) {
      violations.push(violation('dependency_items_count_invalid', [subtask.id, dependency.fromSubtaskId], path, `dependency ${dependency.fromSubtaskId} -> ${subtask.id} must require 1 to 12 items`));
    }
    validateKeyedDescriptions(dependency.requiredItems, path, subtask.id, 'dependency', violations);
  }

  if (subtask.acceptance.length < 1 || subtask.acceptance.length > 12) {
    violations.push(violation('acceptance_count_invalid', [subtask.id], `${base}.acceptance`, `subtask ${subtask.id} must declare 1 to 12 acceptance criteria`));
  }
  validateKeyedDescriptions(subtask.acceptance, `${base}.acceptance`, subtask.id, 'acceptance', violations);
  for (const [acceptanceIndex, acceptance] of subtask.acceptance.entries()) {
    if (acceptance.requiredEvidence.length > 4) {
      violations.push(violation('evidence_requirements_count_invalid', [subtask.id], `${base}.acceptance.${acceptanceIndex}.requiredEvidence`, `acceptance ${acceptance.key} may require at most 4 evidence kinds`));
    }
  }
}

function validateKeyedDescriptions(
  values: Array<{ key: string; description: string }>,
  path: string,
  subtaskId: string,
  scope: 'dependency' | 'acceptance',
  violations: WorkGraphViolation[],
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (!WORK_GRAPH_KEY_PATTERN.test(value.key)) {
      violations.push(violation('invalid_key', [subtaskId], `${path}.${index}.key`, `${scope} key ${value.key || '(empty)'} is invalid`));
    }
    if (seen.has(value.key)) {
      const code = scope === 'dependency' ? 'duplicate_dependency_item_key' : 'duplicate_acceptance_key';
      violations.push(violation(code, [subtaskId], `${path}.${index}.key`, `${scope} key ${value.key} is duplicated`));
    }
    seen.add(value.key);
    if (!value.description.trim() || value.description.length > 500) {
      violations.push(violation('description_invalid', [subtaskId], `${path}.${index}.description`, `${scope} description must contain 1 to 500 characters`));
    }
  }
}

export function contextRefKey(ref: ContextRef): string {
  switch (ref.kind) {
    case 'current_user_input': return ref.kind;
    case 'interaction': return `${ref.kind}:${ref.interactionId}:${ref.side}`;
    case 'task_resource': return `${ref.kind}:${ref.locator}`;
    case 'preference': return `${ref.kind}:${ref.preferenceId}`;
  }
}

function violation(code: WorkGraphViolationCode, subtaskIds: string[], path: string, message: string): WorkGraphViolation {
  return { code, subtaskIds, path, message };
}

function compareViolations(left: WorkGraphViolation, right: WorkGraphViolation): number {
  return left.code.localeCompare(right.code)
    || left.path.localeCompare(right.path)
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
