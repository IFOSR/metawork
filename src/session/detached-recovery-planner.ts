import { randomUUID } from 'node:crypto';
import { AnyFusionPlanningAgent } from '../planning/anyfusion-planning-agent.js';
import { PlanningAgentPlanSchema } from '../planning/planning-agent-plan-schema.js';
import { normalizePlanningAgentPlanInput } from '../planning/planning-agent-plan-normalizer.js';
import { validatePlanningAgentPlan } from '../planning/planning-agent-plan-validator.js';
import type { PlanningContext, PlanningAgentPlan } from '../planning/planning-types.js';
import type { PlannerProcessController } from '../planning/planner-process-supervisor.js';
import type { PlannerHostBridgeSession } from '../tui-bridge/planner-host-bridge.js';
import { KernelApplicationInterruptedError } from '../kernel/kernel-workflow.js';

/** Validation-only Planner host for recovery, independent of connected clients. */
export async function planWithoutClient(input: {
  context: PlanningContext;
  runner: PlannerProcessController;
  registerSession: (id: string, session: PlannerHostBridgeSession) => () => void;
  signal?: AbortSignal;
}): Promise<PlanningAgentPlan> {
  if (input.signal?.aborted) throw new KernelApplicationInterruptedError();
  const sessionId = `recovery-${randomUUID()}`;
  const context = { ...input.context, request: { ...input.context.request, sessionId } };
  const unavailable = (): never => { throw new Error('recovery host only supports proposal validation'); };
  const unregister = input.registerSession(sessionId, {
    subscribe: unavailable,
    getPlannerTuiSnapshot: unavailable,
    getPlannerTuiExecutorResults: unavailable,
    getPlannerTuiPermissionRequests: unavailable,
    resolvePlannerTuiPermission: async () => unavailable(),
    completeCommand: unavailable,
    submitPlannerTuiCommand: async () => unavailable(),
    async submitPlannerProposal(submission, purpose) {
      const base = { turnId: submission.turnId, submissionId: submission.submissionId, planId: null, kernel: null };
      if (purpose !== 'validation' || submission.sessionId !== sessionId || input.signal?.aborted) {
        return { ...base, status: 'rejected', rejectionType: 'validation', issues: ['recovery proposal identity or purpose mismatch'] };
      }
      const plan = normalizePlanningAgentPlanInput(submission.plan);
      const parsed = PlanningAgentPlanSchema.safeParse(plan);
      const validation = validatePlanningAgentPlan(plan, context.configuration);
      if (!parsed.success || !validation.valid) {
        return { ...base, status: 'rejected', rejectionType: 'validation', issues: parsed.success
          ? validation.errors : parsed.error.issues.map(issue => issue.message) };
      }
      return { ...base, status: 'accepted', planId: parsed.data.id, outcome: 'proposal_validated',
        displayText: 'Recovery proposal validated.', taskId: parsed.data.task.taskId };
    },
  });
  const abort = () => { void input.runner.abortSession(sessionId).catch(() => undefined); };
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const plan = await new AnyFusionPlanningAgent({ runner: input.runner }).plan(context);
    if (input.signal?.aborted) throw new KernelApplicationInterruptedError();
    return plan;
  } catch (error) {
    if (input.signal?.aborted) throw new KernelApplicationInterruptedError();
    throw error;
  } finally {
    input.signal?.removeEventListener('abort', abort);
    unregister();
  }
}
