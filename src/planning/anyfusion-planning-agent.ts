import type { RevisionedAgentBinding } from '../core/authorized-executor-binding.js';
import {
  plannerRunFailureDetails,
  type PlannerToolCallTrace,
} from './planner-audit-contract.js';
import {
  getDefaultPlannerProcessSupervisor,
  type PlannerRunner,
} from './planner-process-supervisor.js';
import type { PlannerProposalPurpose, PlannerProposalResult } from './planner-proposal.js';
import type { PlanningAgent, PlanningProposalSubmitter } from './planning-agent.js';
import type { PlannerRunProgressObserver } from './planner-progress.js';
import type { PlanningAgentPlan, PlanningContext } from './planning-types.js';
import { PlanningAgentPlanSchema } from './planning-agent-plan-schema.js';

export interface PlannerAuditBindingContext {
  plannerBinding: RevisionedAgentBinding;
  plannerBindingFingerprint: string;
}

export interface PlannerAuditStartInput extends PlannerAuditBindingContext {
  sessionId: string;
  requestSource: string;
  configurationRevision: string;
}

export interface PlannerAuditPort {
  start(input: PlannerAuditStartInput): { id: string };
  finish(input: {
    id: string;
    status: 'completed' | 'failed';
    attemptCount: number;
    durationMs: number;
    errorSummary?: string | null;
    toolCalls: PlannerToolCallTrace[];
  }): void;
}

export interface AnyFusionPlanningAgentDeps {
  runner: PlannerRunner;
  audit?: PlannerAuditPort;
  resolvePlannerAuditBinding?: (
    configurationRevision: string,
  ) => Promise<PlannerAuditBindingContext>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Deep Planner process adapter. Proposal validation/revision happens inside the
 * Pi tool loop; this module never parses assistant text and never owns a repair
 * loop.
 */
export class AnyFusionPlanningAgent implements PlanningAgent {
  constructor(private readonly deps: AnyFusionPlanningAgentDeps) {}

  async submit(
    context: PlanningContext,
    submitter?: PlanningProposalSubmitter,
  ): Promise<PlannerProposalResult> {
    try {
      return (await this.run(context, 'kernel', submitter?.onProgress)).proposalResult;
    } catch (error) {
      return {
        status: 'transport_uncertain',
        turnId: 'unknown',
        submissionId: 'unknown',
        retryableByReplay: true,
        message: `Planner unavailable: ${(error as Error).message}`,
      };
    }
  }

  async plan(context: PlanningContext): Promise<PlanningAgentPlan> {
    const result = await this.run(context, 'validation');
    if (result.proposalResult.status !== 'accepted'
      || result.proposalResult.outcome !== 'proposal_validated') {
      throw new Error(`Planner proposal did not reach validated terminal state: ${result.proposalResult.status}`);
    }
    const parsed = PlanningAgentPlanSchema.safeParse(result.submittedPlan);
    if (!parsed.success) {
      throw new Error('Planner tool completed without a valid PlanningAgentPlan v8 argument');
    }
    return parsed.data as PlanningAgentPlan;
  }

  private async run(
    context: PlanningContext,
    purpose: PlannerProposalPurpose,
    onProgress?: PlannerRunProgressObserver,
  ) {
    const effectiveContext = {
      ...context,
      timeoutMs: context.timeoutMs > 0 ? context.timeoutMs : DEFAULT_TIMEOUT_MS,
    };
    const auditRun = await this.startAudit(context);
    const startedAt = Date.now();
    try {
      const result = onProgress
        ? await this.deps.runner.run(context.userInput, effectiveContext, purpose, onProgress)
        : await this.deps.runner.run(context.userInput, effectiveContext, purpose);
      if (auditRun) this.finishAudit({
        id: auditRun.id,
        status: 'completed',
        attemptCount: result.toolCalls.filter(call => call.toolName === 'submit_planning_proposal').length,
        durationMs: Date.now() - startedAt,
        toolCalls: result.toolCalls,
      });
      return result;
    } catch (error) {
      const failure = plannerRunFailureDetails(error);
      if (auditRun) this.finishAudit({
        id: auditRun.id,
        status: 'failed',
        attemptCount: failure?.toolCalls.filter(
          call => call.toolName === 'submit_planning_proposal',
        ).length ?? 0,
        durationMs: failure?.durationMs ?? Date.now() - startedAt,
        errorSummary: (error as Error).message,
        toolCalls: failure?.toolCalls ?? [],
      });
      throw error;
    }
  }

  private finishAudit(
    input: Parameters<PlannerAuditPort['finish']>[0],
  ): void {
    try {
      this.deps.audit?.finish(input);
    } catch {
      // Audit persistence is best effort and must not replace the planning result.
    }
  }

  private async startAudit(context: PlanningContext): Promise<{ id: string } | undefined> {
    if (!this.deps.audit || !this.deps.resolvePlannerAuditBinding) return undefined;
    const configurationRevision = context.configuration.revisionId;
    try {
      const bindingContext = await this.deps.resolvePlannerAuditBinding(configurationRevision);
      if (
        bindingContext.plannerBinding.configurationRevision !== configurationRevision
        || bindingContext.plannerBindingFingerprint.length === 0
      ) {
        return undefined;
      }
      return this.deps.audit.start({
        sessionId: context.request.sessionId,
        requestSource: context.request.source,
        configurationRevision,
        ...bindingContext,
      });
    } catch {
      // Audit resolution and persistence must not block Planner execution.
      return undefined;
    }
  }
}

export function createDefaultPlanningAgent(
  deps: Partial<AnyFusionPlanningAgentDeps> = {},
): AnyFusionPlanningAgent {
  return new AnyFusionPlanningAgent({
    runner: deps.runner ?? getDefaultPlannerProcessSupervisor(),
    audit: deps.audit,
    resolvePlannerAuditBinding: deps.resolvePlannerAuditBinding,
  });
}
