import { extractJsonObject } from '../core/llm-json.js';
import { generateInteractionId } from '../utils/id.js';
import { applyContextDefaults, PLANNER_SOURCE, PlanningAgentPlanSchema } from './planning-agent-plan-schema.js';
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
        if (auditRun) this.deps.audit?.finish({
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
        const candidate = applyContextDefaults(parsed.data, effectiveContext);
        const validation = validatePlanningAgentPlan(candidate);
        if (validation.valid) {
          if (auditRun) this.deps.audit?.finish({
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

    if (auditRun) this.deps.audit?.finish({
      id: auditRun.id,
      status: 'failed',
      attemptCount: 2,
      durationMs: Date.now() - startedAt,
      errorSummary: lastErrors.join('; '),
      toolCalls,
    });
    return this.safeClarification(`Planner output failed validation: ${lastErrors.join('; ')}`);
  }

  private safeClarification(reason: string): PlanningAgentPlan {
    return {
      id: `plan_${generateInteractionId()}`,
      schemaVersion: 2,
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
      execution: {
        mode: 'none',
        complexity: 'simple',
        selectedExecutor: null,
        candidateExecutors: [],
        requiresVerification: false,
        canModifyFiles: false,
        requiresExternalGateway: false,
        capabilityClass: 'conversation',
        matchedBoundary: [],
      },
      risk: { level: 'low', requiresConfirmation: false, reasons: [] },
      workGraph: null,
      source: PLANNER_SOURCE,
    };
  }

  private buildPrompt(context: PlanningContext): string {
    return [
      '$metaclaw-planner',
      'Tool rules: call get_runtime_state for current dashboard/status questions; call get_current_session_context for continuation; call search_tasks then get_task_context to resolve a referenced task; call list_executor_classes only when planning executable work.',
      '你是 MetaClaw 的 PlanningAgent。自然语言语义、任务目标、恢复目标、风险、优先级、任务拆分和 AgentClass 选择都由你判断。',
      '代码只会解析显式命令、ID、路径、URL 和附件；不要期待关键词路由兜底。',
      '需要历史、任务状态或执行器事实时主动调用 metaclaw_planner MCP；不得猜测 taskId、阻塞状态或 AgentClass。',
      '新任务不查询无关历史；只有需要创建工作图时才查询执行器目录。证据不足时返回 clarification。',
      '只返回符合 PlanningAgentPlan v2 的 JSON，不要返回 Markdown 或解释。',
      '',
      '约束：',
      '- action: direct_reply | clarification | task_control | plan_work_graph | no_action。',
      '- resume_task/recover_blocked 必须选择明确 taskId、binding=reference，并先查询事实。',
      '- plan_work_graph 必须包含非空、无环的 subtasks；候选执行器必须来自工具查询。',
      '- plan_work_graph、resume_task、recover_blocked 必须设置 task.priority={level,reason}。',
      '- 其他动作的 task.priority 必须是 null。',
      '- status_query scope 只能是 dashboard/blocked/running；clear_tasks scope 只能是 all/parked/blocked。',
      '- 风险动作设置 risk.requiresConfirmation=true；PolicyKernel 会阻止执行并要求确认。',
      '',
      `用户输入：${context.userInput}`,
      `请求身份：${JSON.stringify(context.request)}`,
      `授权边界：${JSON.stringify(context.permissions)}`,
      '',
      `结构示例：${JSON.stringify(PLAN_SCHEMA_EXAMPLE)}`,
    ].join('\n');
  }

  private buildRepairPrompt(context: PlanningContext, errors: string[]): string {
    return [
      '上一次 PlanningAgentPlan 未通过校验，请修正以下错误，只返回完整 JSON：',
      ...errors.map(error => `- ${error}`),
      '',
      this.buildPrompt(context),
    ].join('\n');
  }
}

export function createDefaultPlanningAgent(
  deps: Partial<CodexPlanningAgentDeps> = {},
): CodexPlanningAgent {
  return new CodexPlanningAgent({ runner: deps.runner ?? new CodexPlannerRunner(), audit: deps.audit });
}

const PLAN_SCHEMA_EXAMPLE = {
  id: 'plan_generated_id',
  schemaVersion: 2,
  action: 'direct_reply',
  confidence: 0.9,
  reason: 'answer without state change',
  clarificationQuestion: null,
  response: { directReply: 'answer text' },
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
  execution: {
    mode: 'none',
    complexity: 'simple',
    selectedExecutor: null,
    candidateExecutors: [],
    requiresVerification: false,
    canModifyFiles: false,
    requiresExternalGateway: false,
    capabilityClass: 'conversation',
    matchedBoundary: [],
  },
  risk: { level: 'low|medium|high', requiresConfirmation: false, reasons: [] },
  workGraph: null,
  source: PLANNER_SOURCE,
};
