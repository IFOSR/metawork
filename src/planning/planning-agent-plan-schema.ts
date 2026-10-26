import { z } from 'zod';
import { ROUTING_CAPABILITY_IDS } from '../routing/types.js';
import { isValidFileOutput } from '../work-graph/file-outputs.js';

export const PLANNER_SOURCE = 'anyfusion-planner';

const ACTION_VALUES = [
  'direct_reply',
  'clarification',
  'task_control',
  'plan_work_graph',
  'authorization_resolution',
  'no_action',
] as const;
const TASK_BINDING_VALUES = ['new', 'reference', 'none'] as const;
const TASK_CONTROL_VALUES = [
  'clear_tasks',
  'status_query',
  'resume_task',
  'recover_blocked',
  'service_start',
  'service_stop',
  'service_restart',
  'abandon_task',
  'none',
] as const;
const RISK_LEVEL_VALUES = ['low', 'medium', 'high'] as const;
const TASK_PRIORITY_VALUES = ['normal', 'high', 'urgent'] as const;
const DELIVERY_KIND_VALUES = ['edit', 'report'] as const;
const WORK_GRAPH_ITEM_TYPE_VALUES = ['text', 'artifact'] as const;
const WORK_GRAPH_KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const CONFIGURATION_REFERENCE = /^[a-z][a-z0-9-]{0,63}$/;

const ResponseSchema = z.object({
  directReply: z.string().nullable(),
}).strict();

const TaskSchema = z.object({
  publicProjectDirectory: z.string().min(1).max(500).nullable().optional().describe('Only for an explicitly user-selected existing project: a Workspace-relative directory, never absolute or traversing. Immutable after Task creation.'),
  startServiceAfterPublish: z.boolean().nullable().optional().describe('Set true only when the user explicitly requests implementing AND starting a local service. Executor must produce .metawork-service.json and Runtime starts it after public delivery.'),
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

const DescriptionSchema = z.string().trim().min(1).max(500);
const KeySchema = z.string().regex(WORK_GRAPH_KEY);

// Responses structured output accepts anyOf here but rejects the oneOf emitted
// by Zod's discriminatedUnion. Literal kind fields keep the variants exclusive.
const ContextRefSchema = z.union([
  z.object({ kind: z.literal('current_user_input') }).strict(),
  z.object({
    kind: z.literal('interaction'),
    interactionId: z.string().trim().min(1),
    side: z.enum(['user', 'assistant']),
  }).strict(),
  z.object({
    kind: z.literal('attachment'),
    attachmentId: z.string().trim().min(1).max(240),
  }).strict(),
  z.object({
    kind: z.literal('artifact'),
    artifactId: z.string().trim().min(1).max(240),
  }).strict(),
  z.object({ kind: z.literal('task_resource'), locator: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('task_evidence'), evidenceId: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('preference'), preferenceId: z.string().trim().min(1) }).strict(),
]);

const DependencySchema = z.object({
  fromSubtaskId: z.string().trim().min(1),
  requiredItems: z.array(z.object({
    key: KeySchema,
    type: z.enum(WORK_GRAPH_ITEM_TYPE_VALUES),
    description: DescriptionSchema,
  }).strict()).min(1).max(12),
}).strict();

const AcceptanceSchema = z.object({
  key: KeySchema,
  description: DescriptionSchema,
  requiredEvidence: z.array(z.string().trim().min(1).max(500)).max(4),
}).strict();

const ConfigurationReferenceSchema = z.string().regex(CONFIGURATION_REFERENCE);

const ModelSelectionSchema = z.union([
  z.object({
    mode: z.literal('fixed-by-agent-class'),
  }).strict(),
  z.object({
    mode: z.literal('proposed'),
    modelRef: ConfigurationReferenceSchema,
    reason: z.string().trim().min(1).max(500),
  }).strict(),
  z.object({
    mode: z.literal('agent-class-default'),
  }).strict(),
]);

const ExecutorBindingSchema = z.object({
  agentClassRef: ConfigurationReferenceSchema,
  modelSelection: ModelSelectionSchema,
}).strict();

const SubtaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  dependencies: z.array(DependencySchema),
  contextRefs: z.array(ContextRefSchema).max(12),
  requiredCapabilities: z.array(z.enum(ROUTING_CAPABILITY_IDS)).min(1),
  // Planner may omit concrete bindings. Candidate Builder then enumerates all
  // enabled AgentClasses that satisfy the declared capabilities.
  executorBindings: z.array(ExecutorBindingSchema).max(32),
  deliveryKind: z.enum(DELIVERY_KIND_VALUES).describe(
    'edit: the subtask primarily delivers workspace/file changes; report: the subtask primarily delivers a report or answer. Both delivery kinds may create ordinary user-space files while executing.',
  ),
  fileOutputs: z.array(z.string().min(1).max(500).refine(isValidFileOutput, 'Use a safe workspace-relative file path or dedicated directory ending in /')).max(100).describe(
    'Required final file deliveries only. Use [] for answers, external actions and code edits without downloadable files. Otherwise list relative file paths, or dedicated output directories ending in /. Never add a report/log file just to prove an action. Every entry must have an existing regular file; temporary files outside these paths are not delivered.',
  ),
  acceptance: z.array(AcceptanceSchema).min(1).max(12),
  riskLevel: z.enum(RISK_LEVEL_VALUES),
}).strict().superRefine((subtask, context) => {
  const requiresImageArtifact = subtask.requiredCapabilities.some(
    capability => capability === 'image-generation' || capability === 'image-editing',
  );
  if (requiresImageArtifact && subtask.deliveryKind !== 'edit') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deliveryKind'],
      message: 'image generation and editing require edit delivery with an image artifact',
    });
  }
});

const WorkGraphSchema = z.object({
  schemaVersion: z.literal(7),
  configurationRevision: ConfigurationReferenceSchema,
  reason: z.string(),
  subtasks: z.array(SubtaskSchema).min(1),
}).strict();

const AuthorizationResolutionSchema = z.object({
  requestId: z.string().trim().min(1),
  resolution: z.enum(['approve', 'deny']),
}).strict();

/** §5.4 explicit abandon-and-create: the new plan names the exact old Task to abandon. */
const ConflictResolutionSchema = z.object({
  oldTaskId: z.string().trim().min(1),
}).strict();

/**
 * Planner-owned Workspace intent (2026-10-25 design §4). It is a semantic
 * proposal only: the target Workspace must resolve through the trusted
 * Conversation binding, and every target path stays Workspace-relative.
 */
const WorkspaceIntentSchema = z.object({
  targetWorkspaceId: z.string().trim().min(1).max(240).nullable(),
  targetPaths: z.array(
    z.string().trim().min(1).max(500).refine(
      value => !value.startsWith('/')
        && !value.includes('\\')
        && !value.split('/').some(part => !part || part === '.' || part === '..'),
      'Use Workspace-relative paths without absolute roots, backslashes, empty or traversing segments.',
    ),
  ).max(50),
  operation: z.enum([
    'modify_existing',
    'continue_existing_edit',
    'create_in_target',
    'run_in_target',
    'read_only',
    'ambiguous',
  ]).describe('modify_existing: change an existing target file; continue_existing_edit: keep editing a file this Conversation already changed; create_in_target: add a new file in the target Workspace; run_in_target: run a command or process in the target Workspace; read_only: answer without workspace writes; ambiguous: the side effect needs a user decision.'),
  originalFilePolicy: z.enum(['may_replace', 'must_preserve', 'unknown']),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().min(1).max(1000),
}).strict();

const WorkspaceIntentOutputSchema = WorkspaceIntentSchema;

const PlanFieldsSchema = z.object({
  id: z.string().trim().min(1),
  action: z.enum(ACTION_VALUES),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  clarificationQuestion: z.string().nullable(),
  response: ResponseSchema,
  task: TaskSchema,
  risk: RiskSchema,
  authorizationResolution: AuthorizationResolutionSchema.nullable(),
  conflictResolution: ConflictResolutionSchema.nullable().optional(),
  workGraph: WorkGraphSchema.nullable(),
  source: z.literal(PLANNER_SOURCE),
});

type PlanCoherenceShape = {
  action: z.infer<typeof PlanFieldsSchema>['action'];
  workGraph: unknown;
  authorizationResolution: unknown;
  conflictResolution?: unknown;
  task: { taskId: string | null };
  workspaceIntent?: unknown;
};

/** Action/work-graph coherence shared by every supported plan version. */
function applyPlanCoherence(
  plan: PlanCoherenceShape,
  context: z.RefinementCtx,
): void {
  if (plan.action === 'plan_work_graph' && plan.workGraph === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['workGraph'], message: 'plan_work_graph requires workGraph' });
  }
  if (plan.action !== 'plan_work_graph' && plan.workGraph !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['workGraph'], message: 'non-work-graph actions require null workGraph' });
  }
  if (plan.action === 'authorization_resolution' && plan.authorizationResolution === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['authorizationResolution'], message: 'authorization_resolution requires authorizationResolution' });
  }
  if (plan.action !== 'authorization_resolution' && plan.authorizationResolution !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['authorizationResolution'], message: 'non-authorization actions require null authorizationResolution' });
  }
  if (plan.conflictResolution != null && plan.action !== 'plan_work_graph') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['conflictResolution'], message: 'conflictResolution requires plan_work_graph' });
  }
  if (plan.conflictResolution != null && plan.task.taskId !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['conflictResolution'], message: 'conflictResolution targets a NEW Task (taskId must be null)' });
  }
}

const PlanShapeV9FieldsSchema = PlanFieldsSchema.extend({
  schemaVersion: z.literal(9),
  workspaceIntent: WorkspaceIntentOutputSchema.nullable(),
});

/** Current contract: schema 9 requires a Workspace intent for executable work. */
const PlanShapeV9Schema = PlanShapeV9FieldsSchema.strict().superRefine((plan, context) => {
  applyPlanCoherence(plan, context);
  if (plan.action === 'plan_work_graph' && plan.workspaceIntent === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workspaceIntent'],
      message: 'plan_work_graph requires workspaceIntent',
    });
  }
});

/** Legacy schema 8: no Workspace intent; Kernel keeps the isolated safe default. */
const PlanShapeSchema = PlanFieldsSchema.extend({
  schemaVersion: z.literal(8),
}).strict().superRefine((plan, context) => {
  applyPlanCoherence(plan, context);
});

/**
 * Canonical structured-output contract shared by AnyFusion Planner transports.
 * A union is used because Responses structured output accepts `anyOf` but
 * rejects the `oneOf` emitted by `discriminatedUnion`.
 */
const PlanVersionedShapeSchema = z.union([PlanShapeV9Schema, PlanShapeSchema]);

/**
 * Supported plan versions are checked first so an unsupported version is
 * reported as a `schemaVersion` problem instead of an opaque union failure.
 * The output contract above stays a plain `anyOf` for the tool schema.
 */
export const PlanningAgentPlanSchema = z
  .object({ schemaVersion: z.union([z.literal(9), z.literal(8)]) })
  .loose()
  .pipe(PlanVersionedShapeSchema);

export const PlanningAgentPlanOutputSchema = PlanVersionedShapeSchema;

export type PlanningAgentPlanCandidate = z.infer<typeof PlanningAgentPlanSchema>;
