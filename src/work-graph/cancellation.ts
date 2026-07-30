export type WorkGraphCancellationStatus =
  | 'ready'
  | 'running'
  | 'awaiting_integration'
  | 'awaiting_decision'
  | 'blocked'
  | 'done'
  | 'cancelled';

export interface WorkGraphCancellationFact {
  subtaskId: string;
  status: WorkGraphCancellationStatus;
}

export interface CancellationGraph {
  subtasks: Array<{
    id: string;
    dependencies: Array<{ fromSubtaskId: string }>;
  }>;
}

export type CancellationClosureResult =
  | { ok: true; subtaskIds: string[] }
  | {
      ok: false;
      reason: 'empty_targets' | 'unknown_subtask' | 'already_done' | 'already_cancelled';
      subtaskIds: string[];
    };

/**
 * Derive the all-or-nothing cancellation set for one graph revision.
 *
 * The returned order is deterministic and safe for cancellation projections:
 * deepest downstream nodes first, then Subtask ID.
 */
export function deriveCancellationClosure(
  graph: CancellationGraph,
  facts: readonly WorkGraphCancellationFact[],
  targetSubtaskIds: readonly string[],
): CancellationClosureResult {
  const targets = [...new Set(targetSubtaskIds)].sort();
  if (targets.length === 0) {
    return { ok: false, reason: 'empty_targets', subtaskIds: [] };
  }

  const subtasksById = new Map(graph.subtasks.map(subtask => [subtask.id, subtask]));
  const factsById = new Map(facts.map(fact => [fact.subtaskId, fact]));
  const unknown = targets.filter(id => !subtasksById.has(id) || !factsById.has(id));
  if (unknown.length > 0) {
    return { ok: false, reason: 'unknown_subtask', subtaskIds: unknown };
  }

  const dependents = new Map<string, string[]>();
  for (const subtask of graph.subtasks) {
    for (const dependency of subtask.dependencies) {
      const downstream = dependents.get(dependency.fromSubtaskId) ?? [];
      downstream.push(subtask.id);
      dependents.set(dependency.fromSubtaskId, downstream);
    }
  }
  for (const downstream of dependents.values()) downstream.sort();

  const depths = new Map<string, number>();
  const visit = (subtaskId: string, depth: number): void => {
    const knownDepth = depths.get(subtaskId);
    if (knownDepth !== undefined && knownDepth >= depth) return;
    depths.set(subtaskId, depth);
    for (const dependentId of dependents.get(subtaskId) ?? []) {
      visit(dependentId, depth + 1);
    }
  };
  for (const target of targets) visit(target, 0);

  const closure = [...depths].sort(([leftId, leftDepth], [rightId, rightDepth]) =>
    rightDepth - leftDepth || leftId.localeCompare(rightId)
  ).map(([subtaskId]) => subtaskId);
  const done = closure.filter(id => factsById.get(id)?.status === 'done');
  if (done.length > 0) {
    return { ok: false, reason: 'already_done', subtaskIds: done };
  }
  const cancelled = closure.filter(id => factsById.get(id)?.status === 'cancelled');
  if (cancelled.length > 0) {
    return { ok: false, reason: 'already_cancelled', subtaskIds: cancelled };
  }
  return { ok: true, subtaskIds: closure };
}
