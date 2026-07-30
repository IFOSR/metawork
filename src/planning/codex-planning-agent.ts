import { extractJsonObject } from '../core/llm-json.js';
import { generateInteractionId } from '../utils/id.js';
import { PLANNER_SOURCE, PlanningAgentPlanSchema } from './planning-agent-plan-schema.js';
import { validatePlanningAgentPlan } from './planning-agent-plan-validator.js';
import type { PlanningAgent } from './planning-agent.js';
import {
  CodexPlannerRunner,
  type PlannerCodexRunner,
  type PlannerToolCallTrace,
} from './planner-codex-runner.js';
import type { PlanningAgentPlan, PlanningContext } from './planning-types.js';

export interface CodexPlanningAgentDeps {
  runner: PlannerCodexRunner;
  audit?: {
    start(sessionId: string, requestSource: string): { id: string };
    finish(input: {
      id: string;
      status: 'completed' | 'failed';
      attemptCount: number;
      durationMs: number;
      errorSummary?: string | null;
      toolCalls: PlannerToolCallTrace[];
    }): void;
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class CodexPlanningAgent implements PlanningAgent {
  constructor(private readonly deps: CodexPlanningAgentDeps) {}

  async plan(context: PlanningContext): Promise<PlanningAgentPlan> {
    const effectiveContext = {
      ...context,
      timeoutMs: context.timeoutMs > 0 ? context.timeoutMs : DEFAULT_TIMEOUT_MS,
    };
    let lastErrors: string[] = [];
    const auditRun = this.deps.audit?.start(context.request.sessionId, context.request.source);
    const startedAt = Date.now();
    const toolCalls: PlannerToolCallTrace[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = attempt === 0
        ? this.buildPrompt(effectiveContext)
        : this.buildRepairPrompt(effectiveContext, lastErrors);
      let raw: string;
      try {
        const result = await this.deps.runner.run(prompt, effectiveContext);
        raw = result.output;
        toolCalls.push(...result.toolCalls);
      } catch (error) {
        if (auditRun) this.finishAudit({
          id: auditRun.id,
          status: 'failed',
          attemptCount: attempt + 1,
          durationMs: Date.now() - startedAt,
          errorSummary: (error as Error).message,
          toolCalls,
        });
        return this.safeClarification(`Planner unavailable: ${(error as Error).message}`);
      }

      try {
        const parsed = PlanningAgentPlanSchema.safeParse(extractJsonObject(raw));
        if (!parsed.success) {
          lastErrors = parsed.error.issues.map(issue => issue.message);
          continue;
        }
        const candidate = parsed.data as PlanningAgentPlan;
        const validation = validatePlanningAgentPlan(candidate, effectiveContext.executorCatalog);
        if (validation.valid) {
          if (auditRun) this.finishAudit({
            id: auditRun.id,
            status: 'completed',
            attemptCount: attempt + 1,
            durationMs: Date.now() - startedAt,
            toolCalls,
          });
          return candidate;
        }
        lastErrors = validation.errors;
      } catch {
        lastErrors = ['planner output was not a parseable JSON object'];
      }
    }

    if (auditRun) this.finishAudit({
      id: auditRun.id,
      status: 'failed',
      attemptCount: 2,
      durationMs: Date.now() - startedAt,
      errorSummary: lastErrors.join('; '),
      toolCalls,
    });
    return this.safeClarification(`Planner output failed validation: ${lastErrors.join('; ')}`);
  }

  private finishAudit(
    input: Parameters<NonNullable<CodexPlanningAgentDeps['audit']>['finish']>[0],
  ): void {
    try {
      this.deps.audit?.finish(input);
    } catch {
      // Audit persistence is best effort and must not replace the planning result.
    }
  }

  private safeClarification(reason: string): PlanningAgentPlan {
    return {
      id: `plan_${generateInteractionId()}`,
      schemaVersion: 6,
      action: 'clarification',
      confidence: 0,
      reason,
      clarificationQuestion: '规划服务暂时无法可靠理解该请求，请重试或更明确地说明目标。',
      response: { directReply: null },
      task: {
        binding: 'none',
        taskId: null,
        control: 'none',
        scope: null,
        title: null,
        goal: null,
        includeRecentConversationContext: false,
        priority: null,
      },
      risk: { level: 'low', requiresConfirmation: false, reasons: [] },
      authorizationResolution: null,
      workGraph: null,
      source: PLANNER_SOURCE,
    };
  }

  private buildPrompt(context: PlanningContext): string {
    return context.userInput;
  }

  private buildRepairPrompt(_context: PlanningContext, errors: string[]): string {
    return [
      '上一个回答未通过 PlanningAgentPlan v6 校验。请基于同一对话修正全部错误，只返回完整 JSON：',
      ...errors.map(error => `- ${error}`),
    ].join('\n');
  }
}

export function createDefaultPlanningAgent(
  deps: Partial<CodexPlanningAgentDeps> = {},
): CodexPlanningAgent {
  return new CodexPlanningAgent({ runner: deps.runner ?? new CodexPlannerRunner(), audit: deps.audit });
}
