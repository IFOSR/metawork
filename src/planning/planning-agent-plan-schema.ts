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
import { isCapabilityClass } from '../core/capability-class.js';
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
    id: StringOrEmptySchema,
    schemaVersion: z.literal(1).catch(1),
    action: z.enum(ACTION_VALUES).catch('clarification'),
    confidence: ClampedConfidenceSchema,
    reason: StringOrEmptySchema,
    clarificationQuestion: StringOrNullSchema,
    capabilityClass: z.unknown().optional(),
    response: ResponseCandidateSchema,
    task: TaskCandidateSchema,
    execution: ExecutionCandidateSchema,
    risk: RiskCandidateSchema,
    workGraph: WorkGraphCandidateSchema,
    source: z.literal(PLANNER_SOURCE).catch(PLANNER_SOURCE),
  }),
);

export type PlanningAgentPlanCandidate = z.infer<typeof PlanningAgentPlanSchema>;

export function applyContextDefaults(
  plan: PlanningAgentPlanCandidate,
  context: PlanningContext,
): PlanningAgentPlan {
  const capabilityClass = coerceCapabilityClass(plan.capabilityClass, plan.execution.capabilityClass, plan.action);
  return {
    id: plan.id || `plan_${generateInteractionId()}`,
    schemaVersion: 1,
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
    },
    execution: {
      mode: coerceExecutionMode(plan.execution.mode, plan.action),
      complexity: plan.execution.complexity,
      selectedExecutor: plan.execution.selectedExecutor,
      candidateExecutors: plan.execution.candidateExecutors,
      requiresVerification: plan.execution.requiresVerification,
      canModifyFiles: plan.execution.canModifyFiles && context.allowFileModification,
      requiresExternalGateway: plan.execution.requiresExternalGateway,
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
