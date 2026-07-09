import type { AgentClass } from '../core/types.js';
import { extractJsonObject } from '../core/llm-json.js';
import { generateInteractionId } from '../utils/id.js';
import { applyContextDefaults, PLANNER_SOURCE, PlanningAgentPlanSchema } from './planning-agent-plan-schema.js';
import { validatePlanningAgentPlan } from './planning-agent-plan-validator.js';
import type { PlanningAgent } from './planning-agent.js';
import type {
  PlanningAgentPlan,
  PlanningContext,
} from './planning-types.js';

export interface CodexPlanningAgentDeps {
  llmBridge: {
    query(prompt: string): Promise<string>;
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Real planner adapter: prompts Codex CLI (via LlmBridge) for a PlanningAgentPlan
 * — including a multi-subtask DAG work graph — and returns it directly, replacing
 * the legacy IntentOrchestrator round-trip. Output is coerced into a well-shaped
 * plan, validated (schema + dependency-graph integrity), and repaired once on
 * failure; hard failures degrade to a conservative direct-reply plan so the
 * session never gets stuck when the model is unavailable.
 */
export class CodexPlanningAgent implements PlanningAgent {
  constructor(private readonly deps: CodexPlanningAgentDeps) {}

  async plan(context: PlanningContext): Promise<PlanningAgentPlan> {
    const timeoutMs = context.timeoutMs > 0 ? context.timeoutMs : DEFAULT_TIMEOUT_MS;
    let lastErrors: string[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = attempt === 0
        ? this.buildPrompt(context)
        : this.buildRepairPrompt(context, lastErrors);
      let raw: string;
      try {
        raw = await withTimeout(this.deps.llmBridge.query(prompt), timeoutMs);
      } catch {
        return this.conservativeFallbackPlan('Codex planner 调用失败或超时，保守降级为普通对话');
      }

      let candidate: PlanningAgentPlan;
      try {
        const parsed = PlanningAgentPlanSchema.safeParse(extractJsonObject(raw));
        if (!parsed.success) {
          lastErrors = parsed.error.issues.map(issue => issue.message);
          continue;
        }
        candidate = applyContextDefaults(parsed.data, context);
      } catch {
        lastErrors = ['planner output was not a parseable JSON object'];
        continue;
      }

      const validation = validatePlanningAgentPlan(candidate);
      if (validation.valid) {
        return candidate;
      }
      lastErrors = validation.errors;
    }

    return this.conservativeFallbackPlan(
      `Codex planner 输出未通过校验，保守降级为普通对话：${lastErrors.join('; ')}`,
    );
  }

  private conservativeFallbackPlan(reason: string): PlanningAgentPlan {
    return {
      id: `plan_${generateInteractionId()}`,
      schemaVersion: 1,
      action: 'direct_reply',
      confidence: 0.5,
      reason,
      clarificationQuestion: null,
      response: { directReply: null },
      task: {
        binding: 'none',
        taskId: null,
        control: 'none',
        scope: null,
        title: null,
        goal: null,
        includeRecentConversationContext: false,
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
      '你是 MetaClaw 的顶层规划器（PlanningAgent）。根据用户意图直接产出一个 PlanningAgentPlan。',
      '必须做语义判断，不要用关键词命中做主判断。只返回 JSON 对象，不要解释、不要 markdown。',
      '',
      'action 取值：',
      '- direct_reply：普通对话/解释/闲聊，不创建任务、不派发执行器。',
      '- task_control：查询/清理/恢复/解除阻塞/继续已有任务等 MetaClaw 任务控制。',
      '- plan_work_graph：需要创建可执行任务，产出工作图（可拆成多子任务 DAG）。',
      '- clarification：低置信度、歧义、高风险，需要先追问。',
      '- no_action：无需任何动作。',
      '',
      '恢复/继续/解除阻塞旧任务（resume_task / recover_blocked）的硬约束：',
      '- 必须从下方“最近任务”候选里选定一个明确的 taskId，输出 task.binding="reference" + task.taskId + task.control。',
      '- 不得输出无 taskId 的 resume/recover_blocked 计划。无法唯一确定目标（多个候选都可能、或语义模糊）时，必须返回 action="clarification" 并给出追问问题。',
      '- currentFocus 是当前焦点任务；recentTasks 含每个任务的状态/挂起原因(lastInterruptionReason)/下一步(nextStep)/阻塞原因(blockedReason)，据此选择 taskId。',
      '- “继续刚才的任务”“恢复刚才那个”等表达若无法确定具体 taskId，按 clarification 处理，不要默认指向某个任务。',
      '',
      '工作图（仅 plan_work_graph 需要）：',
      '- 简单请求用单个子任务即可；确有多阶段/多能力/依赖关系时才拆成多子任务 DAG。',
      '- 每个子任务需要唯一 id；dependsOn 只能引用本工作图内其他子任务的 id，且不得成环。',
      '- 每个子任务从下方“可用 AgentClass”中按能力选择 candidateAgentClasses（executor 名称数组）和 agentClassHint。',
      '- expectedOutput 只能取：analysis / patch / artifact / review / summary。',
      '- riskLevel 只能取：low / medium / high。requiredAgentClassKind 通常为 executor。',
      '- 写清 acceptance（验收标准数组）。',
      '',
      'capabilityClass 只能取单个值：code_edit / research / messaging / memory_ops / office_automation / conversation / general。',
      '按工具/副作用边界判断，不按模型推理能力判断。',
      '置信度策略：confidence >= 0.78 可自动执行；0.55 <= confidence < 0.78 低风险可默认、高风险或改文件/发消息/恢复旧任务需 clarification；confidence < 0.55 必须 clarification。',
      '',
      `用户输入：${context.userInput}`,
      `当前会话焦点：${JSON.stringify(context.currentFocus)}`,
      `是否允许创建 durable task：${context.allowDurableTask}`,
      `是否允许修改文件：${context.allowFileModification}`,
      '',
      '最近任务：',
      JSON.stringify(context.recentTasks, null, 2),
      '',
      '可用 AgentClass（含 skills / mcpServers / harness / model / availability / riskLevel / intentAffinity）：',
      JSON.stringify(context.agentClasses.map(summarizeAgentClass), null, 2),
      '',
      'Rule hints（只能作为证据或安全 guard，不能单独决定业务动作）：',
      JSON.stringify(context.hints, null, 2),
      '',
      '返回 JSON schema：',
      JSON.stringify(PLAN_SCHEMA_EXAMPLE, null, 2),
    ].join('\n');
  }

  private buildRepairPrompt(context: PlanningContext, errors: string[]): string {
    return [
      '你上一次返回的 PlanningAgentPlan 未通过校验。请修正以下问题后重新返回完整 JSON 对象，只返回 JSON：',
      ...errors.map(error => `- ${error}`),
      '',
      this.buildPrompt(context),
    ].join('\n');
  }
}

export function createDefaultPlanningAgent(deps: CodexPlanningAgentDeps): CodexPlanningAgent {
  return new CodexPlanningAgent(deps);
}

function summarizeAgentClass(agentClass: AgentClass): Record<string, unknown> {
  return {
    name: agentClass.name,
    kind: agentClass.kind,
    domains: agentClass.domains,
    capabilities: agentClass.capabilities,
    strengths: agentClass.strengths,
    weaknesses: agentClass.weaknesses,
    primaryUseCases: agentClass.primaryUseCases,
    avoidUseCases: agentClass.avoidUseCases,
    skills: agentClass.skills,
    mcpServers: agentClass.mcpServers,
    harness: agentClass.harness,
    model: agentClass.model,
    availability: agentClass.availability,
    riskLevel: agentClass.riskLevel,
    intentAffinity: agentClass.intentAffinity,
  };
}

const PLAN_SCHEMA_EXAMPLE = {
  action: 'direct_reply|clarification|task_control|plan_work_graph|no_action',
  confidence: 0.0,
  reason: '简短语义原因',
  clarificationQuestion: '需要追问时的问题，否则 null',
  capabilityClass: 'code_edit|research|messaging|memory_ops|office_automation|conversation|general',
  response: { directReply: 'direct_reply 时的回复文本，否则 null' },
  task: {
    binding: 'new|reference|none',
    taskId: 'task id or null',
    control: 'clear_tasks|status_query|resume_task|recover_blocked|none',
    scope: 'all|parked|blocked|running|dashboard|null',
    title: '任务标题 or null',
    goal: '任务目标 or null',
    includeRecentConversationContext: false,
  },
  execution: {
    mode: 'none|single_executor|multi_executor',
    complexity: 'simple|moderate|complex',
    selectedExecutor: 'executor name or null',
    candidateExecutors: ['executor name'],
    requiresVerification: false,
    canModifyFiles: false,
    requiresExternalGateway: false,
    matchedBoundary: ['语义边界'],
  },
  risk: { level: 'low|medium|high', requiresConfirmation: false, reasons: ['风险原因'] },
  workGraph: {
    reason: '工作图拆分原因',
    subtasks: [
      {
        id: 'subtask_1',
        title: '子任务标题',
        goal: '子任务目标',
        dependsOn: [],
        requiredAgentClassKind: 'executor',
        agentClassHint: 'executor name or null',
        candidateAgentClasses: ['executor name'],
        expectedOutput: 'analysis|patch|artifact|review|summary',
        acceptance: ['验收标准'],
        riskLevel: 'low|medium|high',
      },
    ],
  },
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('codex planner timed out')), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}
