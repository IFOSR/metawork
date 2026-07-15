// Zod coercion for raw Codex planner JSON into a well-shaped PlanningAgentPlan.
// Every schema here only coerces — it never rejects (`.catch`/preprocess fall back
// to a safe default on any shape mismatch); `validatePlanningAgentPlan` remains the
// sole decision gate that can reject a plan and trigger a repair retry. Context-
// dependent defaults (random plan id, `context.userInput`, `allowFileModification`)
// can't live in a static schema, so `applyContextDefaults` applies them separately
// after parsing. Subtask enums (`requiredAgentClassKind`/`expectedOutput`/`riskLevel`)
// deliberately use `z.unknown()`: a present-but-invalid value must pass through
// unchanged so the validator rejects it and the planner retries, instead of being
// silently defaulted like the top-level enums.
import { z } from 'zod';
import type { CapabilityClass } from '../core/capability-class.js';
import { CAPABILITY_CLASSES, isCapabilityClass } from '../core/capability-class.js';
import { generateInteractionId } from '../utils/id.js';
import type {
  IntentExecutionMode,
  PlanningAction,
  PlanningAgentPlan,
  PlanningContext,
  SubtaskProposal,
  WorkGraphProposal,
} from './planning-types.js';

export const PLANNER_SOURCE = 'codex-planner';

const ACTION_VALUES = [
  'direct_reply',
  'clarification',
  'task_control',
  'plan_work_graph',
  'no_action',
] as const;
const TASK_BINDING_VALUES = ['new', 'reference', 'none'] as const;
const TASK_CONTROL_VALUES = [
  'clear_tasks',
  'status_query',
  'resume_task',
  'recover_blocked',
  'none',
] as const;
const EXECUTION_MODE_VALUES = ['none', 'single_executor', 'multi_executor'] as const;
const COMPLEXITY_VALUES = ['simple', 'moderate', 'complex'] as const;
const RISK_LEVEL_VALUES = ['low', 'medium', 'high'] as const;
const TASK_PRIORITY_VALUES = ['normal', 'high', 'urgent'] as const;
const AGENT_CLASS_KIND_VALUES = ['planner', 'executor'] as const;
const EXPECTED_OUTPUT_VALUES = ['analysis', 'patch', 'artifact', 'review', 'summary'] as const;

const StringOrEmptySchema = z.string().catch('');

const StringOrNullSchema = z.preprocess(
  value => typeof value === 'string' && value ? value : null,
  z.string().nullable(),
);

const StringArraySchema = z.preprocess(
  value => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
  z.array(z.string()),
);

const BooleanTrueSchema = z.preprocess(value => value === true, z.boolean());

const TaskPrioritySchema = z.preprocess(
  value => isRecord(value) ? value : null,
  z.object({
    level: z.enum(TASK_PRIORITY_VALUES),
    reason: z.string(),
  }).nullable().catch(null),
);

const ClampedConfidenceSchema = z.preprocess((value) => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}, z.number());

const ResponseCandidateSchema = z.preprocess(
  value => isRecord(value) ? value : {},
  z.object({
    directReply: StringOrNullSchema,
  }),
);

const TaskCandidateSchema = z.preprocess(
  value => isRecord(value) ? value : {},
  z.object({
    binding: z.enum(TASK_BINDING_VALUES).catch('none'),
    taskId: StringOrNullSchema,
    control: z.enum(TASK_CONTROL_VALUES).catch('none'),
    scope: StringOrNullSchema,
    title: StringOrEmptySchema,
    goal: StringOrEmptySchema,
    includeRecentConversationContext: BooleanTrueSchema,
    priority: TaskPrioritySchema,
  }),
);

const ExecutionCandidateSchema = z.preprocess(
  value => isRecord(value) ? value : {},
  z.object({
    mode: z.unknown().optional(),
    complexity: z.enum(COMPLEXITY_VALUES).catch('simple'),
    selectedExecutor: StringOrNullSchema,
    candidateExecutors: StringArraySchema,
    requiresVerification: BooleanTrueSchema,
    canModifyFiles: BooleanTrueSchema,
    requiresExternalGateway: BooleanTrueSchema,
    capabilityClass: z.unknown().optional(),
    matchedBoundary: StringArraySchema,
  }),
);

const RiskCandidateSchema = z.preprocess(
  value => isRecord(value) ? value : {},
  z.object({
    level: z.enum(RISK_LEVEL_VALUES).catch('low'),
    requiresConfirmation: BooleanTrueSchema,
    reasons: StringArraySchema,
  }),
);

const SubtaskCandidateSchema = z.preprocess(
  value => isRecord(value) ? value : {},
  z.object({
    id: StringOrEmptySchema,
    title: StringOrEmptySchema,
    goal: StringOrEmptySchema,
    dependsOn: StringArraySchema,
    requiredAgentClassKind: z.unknown().optional(),
    agentClassHint: StringOrNullSchema,
    candidateAgentClasses: StringArraySchema,
    expectedOutput: z.unknown().optional(),
    acceptance: StringArraySchema,
    riskLevel: z.unknown().optional(),
  }),
);

const SubtaskArraySchema = z.preprocess(
  value => Array.isArray(value) ? value.filter(isRecord) : [],
  z.array(SubtaskCandidateSchema),
);

const WorkGraphCandidateSchema = z.preprocess(
  value => isRecord(value) ? value : {},
  z.object({
    reason: StringOrEmptySchema,
    subtasks: SubtaskArraySchema,
  }),
);

export const PlanningAgentPlanSchema = z.preprocess(
  value => isRecord(value) ? value : {},
  z.object({
    id: StringOrEmptySchema,                    // 计划唯一ID，缺失时由 applyContextDefaults 生成
    schemaVersion: z.literal(2),                // schema v2 adds task priority
    action: z.enum(ACTION_VALUES).catch('clarification'), // 规划动作：直接回复/澄清/任务控制/规划工作图/无动作
    confidence: ClampedConfidenceSchema,        // 规划置信度 0~1，越界或非法值 clamp 到 [0,1]
    reason: StringOrEmptySchema,                // 选择该 action 的原因
    clarificationQuestion: StringOrNullSchema,  // action=clarification 时的追问内容
    capabilityClass: z.unknown().optional(),    // 能力分类（顶层），非法值透传给 validatePlanningAgentPlan
    response: ResponseCandidateSchema,          // 直接回复内容 { directReply: string | null }
    task: TaskCandidateSchema,                  // 任务绑定/控制信息（binding、taskId、control 等）
    execution: ExecutionCandidateSchema,        // 执行配置（mode、complexity、selectedExecutor 等）
    risk: RiskCandidateSchema,                  // 风险评估（level、requiresConfirmation、reasons）
    workGraph: WorkGraphCandidateSchema,        // 工作图（reason + subtasks[]），action=plan_work_graph 时必填
    source: z.literal(PLANNER_SOURCE).catch(PLANNER_SOURCE), // 规划来源标识，固定为 'codex-planner'
  }),
);

export type PlanningAgentPlanCandidate = z.infer<typeof PlanningAgentPlanSchema>;

/** Canonical structured-output contract used to generate Codex --output-schema. */
export const PlanningAgentPlanOutputSchema = z.object({
  id: z.string(),
  schemaVersion: z.literal(2),
  action: z.enum(ACTION_VALUES),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  clarificationQuestion: z.string().nullable(),
  response: z.object({ directReply: z.string().nullable() }),
  task: z.object({
    binding: z.enum(TASK_BINDING_VALUES),
    taskId: z.string().nullable(),
    control: z.enum(TASK_CONTROL_VALUES),
    scope: z.string().nullable(),
    title: z.string().nullable(),
    goal: z.string().nullable(),
    includeRecentConversationContext: z.boolean(),
    priority: z.object({
      level: z.enum(TASK_PRIORITY_VALUES),
      reason: z.string(),
    }).nullable(),
  }),
  execution: z.object({
    mode: z.enum(EXECUTION_MODE_VALUES),
    complexity: z.enum(COMPLEXITY_VALUES),
    selectedExecutor: z.string().nullable(),
    candidateExecutors: z.array(z.string()),
    requiresVerification: z.boolean(),
    canModifyFiles: z.boolean(),
    requiresExternalGateway: z.boolean(),
    capabilityClass: z.enum(CAPABILITY_CLASSES),
    matchedBoundary: z.array(z.string()),
  }),
  risk: z.object({
    level: z.enum(RISK_LEVEL_VALUES),
    requiresConfirmation: z.boolean(),
    reasons: z.array(z.string()),
  }),
  workGraph: z.object({
    reason: z.string(),
    subtasks: z.array(z.object({
      id: z.string(),
      title: z.string(),
      goal: z.string(),
      dependsOn: z.array(z.string()),
      requiredAgentClassKind: z.enum(AGENT_CLASS_KIND_VALUES),
      agentClassHint: z.string().nullable(),
      candidateAgentClasses: z.array(z.string()),
      expectedOutput: z.enum(EXPECTED_OUTPUT_VALUES),
      acceptance: z.array(z.string()),
      riskLevel: z.enum(RISK_LEVEL_VALUES),
    })).min(1),
  }).nullable(),
  source: z.literal(PLANNER_SOURCE),
});

export function applyContextDefaults(
  plan: PlanningAgentPlanCandidate,
  context: PlanningContext,
): PlanningAgentPlan {
  const capabilityClass = coerceCapabilityClass(plan.capabilityClass, plan.execution.capabilityClass, plan.action);
  return {
    id: plan.id || `plan_${generateInteractionId()}`,
    schemaVersion: 2,
    action: plan.action,
    confidence: plan.confidence,
    reason: plan.reason || 'codex planner decision',
    clarificationQuestion: plan.clarificationQuestion,
    response: {
      directReply: plan.response.directReply,
    },
    task: {
      binding: plan.task.binding,
      taskId: plan.task.taskId,
      control: plan.task.control,
      scope: plan.task.scope,
      title: plan.task.title || (plan.action === 'plan_work_graph' ? context.userInput.slice(0, 50) : null),
      goal: plan.task.goal || (plan.action === 'plan_work_graph' ? context.userInput : null),
      includeRecentConversationContext: plan.task.includeRecentConversationContext,
      priority: plan.task.priority,
    },
    execution: {
      mode: coerceExecutionMode(plan.execution.mode, plan.action),
      complexity: plan.execution.complexity,
      selectedExecutor: plan.execution.selectedExecutor,
      candidateExecutors: plan.execution.candidateExecutors,
      requiresVerification: plan.execution.requiresVerification,
      canModifyFiles: plan.execution.canModifyFiles && context.permissions.allowFileModification,
      requiresExternalGateway: plan.execution.requiresExternalGateway && context.permissions.allowExternalGateway,
      capabilityClass,
      matchedBoundary: plan.execution.matchedBoundary,
    },
    risk: {
      level: plan.risk.level,
      requiresConfirmation: plan.risk.requiresConfirmation,
      reasons: plan.risk.reasons,
    },
    workGraph: plan.action === 'plan_work_graph'
      ? applyWorkGraphDefaults(plan.workGraph, context, capabilityClass)
      : null,
    source: PLANNER_SOURCE,
  };
}

function applyWorkGraphDefaults(
  workGraph: PlanningAgentPlanCandidate['workGraph'],
  context: PlanningContext,
  capabilityClass: CapabilityClass,
): WorkGraphProposal {
  return {
    reason: workGraph.reason || 'codex planner proposed work graph',
    subtasks: workGraph.subtasks.map((subtask, index) =>
      applySubtaskDefaults(subtask, index, context, capabilityClass)
    ),
  };
}

function applySubtaskDefaults(
  subtask: PlanningAgentPlanCandidate['workGraph']['subtasks'][number],
  index: number,
  context: PlanningContext,
  capabilityClass: CapabilityClass,
): SubtaskProposal {
  return {
    id: subtask.id || `subtask_${index + 1}`,
    title: subtask.title || context.userInput.slice(0, 50) || 'Execute task',
    goal: subtask.goal || context.userInput,
    dependsOn: subtask.dependsOn,
    requiredAgentClassKind: enumOrRaw<SubtaskProposal['requiredAgentClassKind']>(
      subtask.requiredAgentClassKind,
      'executor',
    ),
    agentClassHint: subtask.agentClassHint,
    candidateAgentClasses: subtask.candidateAgentClasses,
    expectedOutput: enumOrRaw<SubtaskProposal['expectedOutput']>(
      subtask.expectedOutput,
      capabilityClass === 'code_edit' ? 'patch' : 'summary',
    ),
    acceptance: subtask.acceptance,
    riskLevel: enumOrRaw<SubtaskProposal['riskLevel']>(subtask.riskLevel, 'low'),
  };
}

function coerceCapabilityClass(
  planCapabilityClass: unknown,
  executionCapabilityClass: unknown,
  action: PlanningAction,
): CapabilityClass {
  if (isCapabilityClass(planCapabilityClass)) return planCapabilityClass;
  if (isCapabilityClass(executionCapabilityClass)) return executionCapabilityClass;
  return action === 'plan_work_graph' ? 'general' : 'conversation';
}

function coerceExecutionMode(value: unknown, action: PlanningAction): IntentExecutionMode {
  if (isExecutionMode(value)) return value;
  return action === 'plan_work_graph' ? 'single_executor' : 'none';
}

function enumOrRaw<T>(raw: unknown, fallback: T): T {
  return raw === undefined || raw === null || raw === '' ? fallback : (raw as T);
}

function isExecutionMode(value: unknown): value is IntentExecutionMode {
  return EXECUTION_MODE_VALUES.includes(value as IntentExecutionMode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
