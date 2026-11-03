function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonicalizes representation-only differences at the MetaClaw Planner intake
 * boundary. Submission identity continues to use the unmodified wire payload.
 *
 * `configurationRevision` is a runtime identity fact, not model semantics: the
 * Runtime knows which configuration is active, and the Kernel authorizes bindings
 * against exactly that revision. Asking the model to copy it verbatim produced a
 * deadlock once (an activation id outside the reference grammar, where the
 * proposal schema rejected the only correct value while the validator required
 * it). The authoritative value therefore overwrites whatever the model sent.
 */
export function normalizePlanningAgentPlanInput(
  value: unknown,
  options: { configurationRevision?: string | null } = {},
): unknown {
  const revision = typeof options.configurationRevision === 'string'
    && options.configurationRevision.trim().length > 0
    ? options.configurationRevision.trim()
    : undefined;
  if (!isRecord(value)) return value;
  const taskId = isRecord(value.task) ? value.task.taskId : undefined;
  const normalized = typeof taskId === 'string' && taskId.trim().length === 0
    ? { ...value, task: { ...(value.task as Record<string, unknown>), taskId: null } }
    : value;
  if (!revision || !isRecord(normalized.workGraph)) return normalized;
  const workGraph = normalized.workGraph;
  if (workGraph.configurationRevision === revision) return normalized;
  return { ...normalized, workGraph: { ...workGraph, configurationRevision: revision } };
}
