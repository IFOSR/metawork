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
/**
 * Scheduling priority is a user/host signal, not model semantics. A Planner that
 * omits it must not fail the whole Turn three times in a row (observed with a
 * fast Manager model); the host defaults to `normal` and the validator stays
 * strict about malformed values the model actually sent.
 */
function normalizeSchedulingPriority(
  plan: Record<string, unknown>,
): Record<string, unknown> {
  const schedulable = plan.action === 'plan_work_graph'
    || (plan.action === 'task_control' && isRecord(plan.task)
      && (plan.task.control === 'resume_task' || plan.task.control === 'recover_blocked'));
  if (!schedulable || !isRecord(plan.task) || plan.task.priority != null) return plan;
  return {
    ...plan,
    task: {
      ...plan.task,
      priority: { level: 'normal', reason: 'Host default: the Planner did not specify priority' },
    },
  };
}

/** Nullable planner fields may be omitted by providers despite the output schema. */
function normalizeNullableClarification(
  plan: Record<string, unknown>,
): Record<string, unknown> {
  if (plan.clarificationQuestion !== undefined) return plan;
  return { ...plan, clarificationQuestion: null };
}

const PLAN_SCHEMA_VERSION = 9;
const PLANNER_SOURCE = 'anyfusion-planner';

/** Fields the Runtime owns: the model must not be able to get them wrong. */
function normalizeHostOwnedIdentity(
  plan: Record<string, unknown>,
  options: { id?: string },
): Record<string, unknown> {
  return {
    ...plan,
    schemaVersion: PLAN_SCHEMA_VERSION,
    source: PLANNER_SOURCE,
    ...(options.id ? { id: options.id } : {}),
  };
}

export function normalizePlanningAgentPlanInput(
  value: unknown,
  options: { configurationRevision?: string | null; id?: string } = {},
): unknown {
  const revision = typeof options.configurationRevision === 'string'
    && options.configurationRevision.trim().length > 0
    ? options.configurationRevision.trim()
    : undefined;
  if (!isRecord(value)) return value;
  const hostOwned = normalizeHostOwnedIdentity(value, options);
  const taskId = isRecord(hostOwned.task) ? hostOwned.task.taskId : undefined;
  const normalized = typeof taskId === 'string' && taskId.trim().length === 0
    ? { ...hostOwned, task: { ...(hostOwned.task as Record<string, unknown>), taskId: null } }
    : hostOwned;
  const withNullableClarification = normalizeNullableClarification(normalized);
  const withPriority = normalizeSchedulingPriority(withNullableClarification);
  if (!revision || !isRecord(withPriority.workGraph)) return withPriority;
  const workGraph = withPriority.workGraph;
  if (workGraph.configurationRevision === revision) return withPriority;
  return { ...withPriority, workGraph: { ...workGraph, configurationRevision: revision } };
}
