import { randomUUID } from 'node:crypto';
import { PlanningAgentPlanSchema } from '../planning/planning-agent-plan-schema.js';
import { normalizePlanningAgentPlanInput } from '../planning/planning-agent-plan-normalizer.js';
import { validatePlanningAgentPlan } from '../planning/planning-agent-plan-validator.js';
import type { PlanningContext, PlanningAgentPlan } from '../planning/planning-types.js';
import type { PlanningAgent } from '../planning/planning-agent.js';
import { ControlApplicationInterruptedError } from '../control/control-workflow.js';

/**
 * Validation-only planning for recovery, with no client attached.
 *
 * The Manager transport needs no host bridge here: a recovery replan is planned
 * and validated for the Task's own durable binding, and the plan never reaches a
 * user surface. Validation stays in MetaWork's process, using the same schema and
 * semantic validator as a foreground turn.
 */
export async function planWithoutClient(input: {
  context: PlanningContext;
  /** The account's planning agent (Manager transport in current builds). */
  planningAgent: Pick<PlanningAgent, 'plan'>;
  /** Aborts the Manager turn; the recovery loop cancels through this. */
  abort?: () => Promise<void> | void;
  signal?: AbortSignal;
}): Promise<PlanningAgentPlan> {
  if (input.signal?.aborted) throw new ControlApplicationInterruptedError();
  const sessionId = `recovery-${randomUUID()}`;
  const context = {
    ...input.context,
    signal: input.signal ?? input.context.signal,
    request: { ...input.context.request, sessionId },
  };
  const abort = () => { void input.abort?.(); };
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const plan = await input.planningAgent.plan(context);
    if (input.signal?.aborted) throw new ControlApplicationInterruptedError();
    const normalized = normalizePlanningAgentPlanInput(plan, {
      configurationRevision: context.configuration.revisionId,
    });
    const parsed = PlanningAgentPlanSchema.safeParse(normalized);
    if (!parsed.success) {
      throw new Error(
        `recovery proposal failed schema validation: ${parsed.error.issues
          .map(issue => issue.message)
          .join('; ')}`,
      );
    }
    const validation = validatePlanningAgentPlan(
      normalized,
      context.configuration,
      context.pendingAuthorizationRequest,
      context.replan,
    );
    if (!validation.valid) {
      throw new Error(`recovery proposal failed semantic validation: ${validation.errors.join('; ')}`);
    }
    return parsed.data as PlanningAgentPlan;
  } catch (error) {
    if (input.signal?.aborted) throw new ControlApplicationInterruptedError();
    throw error;
  } finally {
    input.signal?.removeEventListener('abort', abort);
  }
}
