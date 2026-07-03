import type { AgentClass } from '../core/types.js';
import type {
  IntentExecutionComplexity,
  IntentExecutionMode,
  IntentRiskLevel,
  IntentTaskBinding,
  IntentTaskControl,
} from '../core/intent-orchestrator.js';
import type { CapabilityClass } from '../core/capability-class.js';
import { isCapabilityClass } from '../core/capability-class.js';
import { extractJsonObject } from '../core/llm-json.js';
import { generateInteractionId } from '../utils/id.js';
import { validatePlanningAgentPlan } from './planning-agent-plan-validator.js';
import type { PlanningAgent } from './planning-agent.js';
import type {
  PlanningAction,
  PlanningAgentPlan,
  PlanningContext,
  SubtaskProposal,
  WorkGraphProposal,
} from './planning-types.js';

export interface CodexPlanningAgentDeps {
  llmBridge: {
    query(prompt: string): Promise<string>;
  };
}

const PLANNER_SOURCE = 'codex-planner';
const DEFAULT_TIMEOUT_MS = 30_000;

const ACTIONS = new Set<PlanningAction>([
  'direct_reply',
  'clarification',
  'task_control',
  'plan_work_graph',
  'no_action',
]);
const TASK_BINDINGS = new Set<IntentTaskBinding>(['new', 'reference', 'none']);
const TASK_CONTROLS = new Set<IntentTaskControl>([
  'clear_tasks',
  'status_query',
  'resume_task',
  'recover_blocked',
  'last_task_continuation',
  'none',
]);
const EXECUTION_MODES = new Set<IntentExecutionMode>(['none', 'single_executor', 'multi_executor']);
const COMPLEXITIES = new Set<IntentExecutionComplexity>(['simple', 'moderate', 'complex']);
const RISK_LEVELS = new Set<IntentRiskLevel>(['low', 'medium', 'high']);

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
        candidate = this.coerceToPlan(extractJsonObject(raw), context);
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

  private coerceToPlan(raw: unknown, context: PlanningContext): PlanningAgentPlan {
    if (!raw || typeof raw !== 'object') {
      throw new Error('planner output was not a JSON object');
    }
    const value = raw as Record<string, unknown>;
    const action = ACTIONS.has(value.action as PlanningAction) ? (value.action as PlanningAction) : 'clarification';
    const task = (value.task && typeof value.task === 'object' ? value.task : {}) as Record<string, unknown>;
    const execution = (value.execution && typeof value.execution === 'object' ? value.execution : {}) as Record<string, unknown>;
    const risk = (value.risk && typeof value.risk === 'object' ? value.risk : {}) as Record<string, unknown>;
    const response = (value.response && typeof value.response === 'object' ? value.response : {}) as Record<string, unknown>;

    const capabilityClass = isCapabilityClass(value.capabilityClass)
      ? value.capabilityClass
      : this.coerceCapabilityClass(execution.capabilityClass, action);

    return {
      id: asString(value.id) || `plan_${generateInteractionId()}`,
      schemaVersion: 1,
      action,
      confidence: clampConfidence(value.confidence),
      reason: asString(value.reason) || 'codex planner decision',
      clarificationQuestion: asString(value.clarificationQuestion) || null,
      response: {
        directReply: asString(response.directReply) || null,
      },
      task: {
        binding: TASK_BINDINGS.has(task.binding as IntentTaskBinding) ? (task.binding as IntentTaskBinding) : 'none',
        taskId: asString(task.taskId) || null,
        control: TASK_CONTROLS.has(task.control as IntentTaskControl) ? (task.control as IntentTaskControl) : 'none',
        scope: asString(task.scope) || null,
        title: asString(task.title) || (action === 'plan_work_graph' ? context.userInput.slice(0, 50) : null),
        goal: asString(task.goal) || (action === 'plan_work_graph' ? context.userInput : null),
        includeRecentConversationContext: task.includeRecentConversationContext === true,
      },
      execution: {
        mode: EXECUTION_MODES.has(execution.mode as IntentExecutionMode)
          ? (execution.mode as IntentExecutionMode)
          : action === 'plan_work_graph' ? 'single_executor' : 'none',
        complexity: COMPLEXITIES.has(execution.complexity as IntentExecutionComplexity)
          ? (execution.complexity as IntentExecutionComplexity)
          : 'simple',
        selectedExecutor: asString(execution.selectedExecutor) || null,
        candidateExecutors: asStringArray(execution.candidateExecutors),
        requiresVerification: execution.requiresVerification === true,
        canModifyFiles: execution.canModifyFiles === true && context.allowFileModification,
        requiresExternalGateway: execution.requiresExternalGateway === true,
        capabilityClass,
        matchedBoundary: asStringArray(execution.matchedBoundary),
      },
      risk: {
        level: RISK_LEVELS.has(risk.level as IntentRiskLevel) ? (risk.level as IntentRiskLevel) : 'low',
        requiresConfirmation: risk.requiresConfirmation === true,
        reasons: asStringArray(risk.reasons),
      },
      workGraph: action === 'plan_work_graph'
        ? this.coerceWorkGraph(value.workGraph, context, capabilityClass)
        : null,
      source: PLANNER_SOURCE,
    };
  }

  private coerceWorkGraph(
    raw: unknown,
    context: PlanningContext,
    capabilityClass: CapabilityClass,
  ): WorkGraphProposal {
    const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const rawSubtasks = Array.isArray(value.subtasks) ? value.subtasks : [];
    const subtasks = rawSubtasks
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item, index) => this.coerceSubtask(item, index, context, capabilityClass));
    return {
      reason: asString(value.reason) || 'codex planner proposed work graph',
      subtasks,
    };
  }

  private coerceSubtask(
    raw: Record<string, unknown>,
    index: number,
    context: PlanningContext,
    capabilityClass: CapabilityClass,
  ): SubtaskProposal {
    const candidateAgentClasses = asStringArray(raw.candidateAgentClasses);
    const hint = asString(raw.agentClassHint) || null;
    // For enum fields the validator can reject, only substitute a default when
    // the field is genuinely absent. A present-but-invalid value is preserved so
    // validatePlanningAgentPlan rejects it and the planner triggers a repair
    // retry, rather than silently rewriting a wrong agent/output/risk intent.
    return {
      id: asString(raw.id) || `subtask_${index + 1}`,
      title: asString(raw.title) || context.userInput.slice(0, 50) || 'Execute task',
      goal: asString(raw.goal) || context.userInput,
      dependsOn: asStringArray(raw.dependsOn),
      requiredAgentClassKind: enumOrRaw<SubtaskProposal['requiredAgentClassKind']>(raw.requiredAgentClassKind, 'executor'),
      agentClassHint: hint,
      candidateAgentClasses,
      expectedOutput: enumOrRaw<SubtaskProposal['expectedOutput']>(
        raw.expectedOutput,
        capabilityClass === 'code_edit' ? 'patch' : 'summary',
      ),
      acceptance: asStringArray(raw.acceptance),
      riskLevel: enumOrRaw<SubtaskProposal['riskLevel']>(raw.riskLevel, 'low'),
    };
  }

  private coerceCapabilityClass(value: unknown, action: PlanningAction): CapabilityClass {
    if (isCapabilityClass(value)) {
      return value;
    }
    return action === 'plan_work_graph' ? 'general' : 'conversation';
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
    control: 'clear_tasks|status_query|resume_task|recover_blocked|last_task_continuation|none',
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

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// Substitute `fallback` only when the field is genuinely absent. A present but
// invalid value is passed through unchanged so validatePlanningAgentPlan can
// reject it (triggering a repair retry) instead of being silently defaulted.
function enumOrRaw<T>(raw: unknown, fallback: T): T {
  return raw === undefined || raw === null || raw === '' ? fallback : (raw as T);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function clampConfidence(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

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
