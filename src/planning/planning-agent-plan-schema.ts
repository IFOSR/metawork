import { z } from 'zod';

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
const RISK_LEVEL_VALUES = ['low', 'medium', 'high'] as const;
const TASK_PRIORITY_VALUES = ['normal', 'high', 'urgent'] as const;
const EXPECTED_OUTPUT_VALUES = ['analysis', 'patch', 'artifact', 'review', 'summary'] as const;
const ROUTING_CAPABILITY_VALUES = ['current-web-research', 'workspace-engineering'] as const;
const BUILTIN_EXECUTOR_VALUES = ['codex-cli', 'pi-agent'] as const;

const ResponseSchema = z.object({
  directReply: z.string().nullable(),
}).strict();

const TaskSchema = z.object({
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
  }).strict().nullable(),
}).strict();

const RiskSchema = z.object({
  level: z.enum(RISK_LEVEL_VALUES),
  requiresConfirmation: z.boolean(),
  reasons: z.array(z.string()),
}).strict();

const SubtaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  dependsOn: z.array(z.string()),
  requiredCapabilities: z.array(z.enum(ROUTING_CAPABILITY_VALUES)).min(1),
  preferredAgentClassList: z.array(z.enum(BUILTIN_EXECUTOR_VALUES)).min(1),
  expectedOutput: z.enum(EXPECTED_OUTPUT_VALUES),
  acceptance: z.array(z.string()),
  riskLevel: z.enum(RISK_LEVEL_VALUES),
}).strict();

const WorkGraphSchema = z.object({
  reason: z.string(),
  subtasks: z.array(SubtaskSchema).min(1),
}).strict();

const PlanShapeSchema = z.object({
  id: z.string(),
  schemaVersion: z.literal(3),
  action: z.enum(ACTION_VALUES),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  clarificationQuestion: z.string().nullable(),
  response: ResponseSchema,
  task: TaskSchema,
  risk: RiskSchema,
  workGraph: WorkGraphSchema.nullable(),
  source: z.literal(PLANNER_SOURCE),
}).strict().superRefine((plan, context) => {
  if (plan.action === 'plan_work_graph' && plan.workGraph === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['workGraph'], message: 'plan_work_graph requires workGraph' });
  }
  if (plan.action !== 'plan_work_graph' && plan.workGraph !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['workGraph'], message: 'non-work-graph actions require null workGraph' });
  }
});

/** Strict parser for raw Planner JSON. It never supplies semantic defaults. */
export const PlanningAgentPlanSchema = PlanShapeSchema;

/** Canonical structured-output contract used to generate Codex --output-schema. */
export const PlanningAgentPlanOutputSchema = PlanShapeSchema;

export type PlanningAgentPlanCandidate = z.infer<typeof PlanningAgentPlanSchema>;
