import type { PlannerConfigurationView } from '../configuration/index.js';
import type { ConfigurationCatalogAgentClass } from '../routing/types.js';
import { PlanningAgentPlanSchema } from './planning-agent-plan-schema.js';
import type { PlanningAgentPlan, SubtaskProposal } from './planning-types.js';
import { validateWorkGraph } from '../work-graph/index.js';

export interface PlanningAgentPlanValidationResult {
  valid: boolean;
  errors: string[];
}

const TASK_PRIORITIES = new Set(['normal', 'high', 'urgent']);

export function validatePlanningAgentPlan(
  value: unknown,
  configuration: PlannerConfigurationView,
  pendingAuthorizationRequest: { requestId: string; taskId: string } | null = null,
): PlanningAgentPlanValidationResult {
  const parsed = PlanningAgentPlanSchema.safeParse(value);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues
        .map(issue => `${issue.path.join('.') || 'plan'}: ${issue.message}`)
        .sort(),
    };
  }

  const plan = parsed.data as PlanningAgentPlan;
  const errors: string[] = [];
  validateActionSemantics(plan, errors);
  validateTaskControlScope(plan, errors);
  validateTaskPriority(plan, errors);
  validateAuthorizationResolution(plan, pendingAuthorizationRequest, errors);

  if (plan.workGraph) {
    errors.push(...validateWorkGraph(plan.workGraph).map(
      violation => `${violation.code}: ${violation.path}: ${violation.message}`,
    ));
    validateConfigurationRevision(plan.workGraph.configurationRevision, configuration, errors);
    validateRouting(plan.workGraph.subtasks, configuration, errors);
  }

  return { valid: errors.length === 0, errors: errors.sort() };
}

function validateConfigurationRevision(
  graphRevision: string,
  configuration: PlannerConfigurationView,
  errors: string[],
): void {
  if (configuration.routingCatalog.configurationRevision !== configuration.revisionId) {
    errors.push(
      `Planner configuration view revision ${configuration.revisionId} does not match routing catalog revision ${configuration.routingCatalog.configurationRevision}`,
    );
  }
  if (graphRevision !== configuration.revisionId) {
    errors.push(
      `work graph configurationRevision ${graphRevision} does not match Planner configuration revision ${configuration.revisionId}`,
    );
  }
}

function validateAuthorizationResolution(
  plan: PlanningAgentPlan,
  pending: { requestId: string; taskId: string } | null,
  errors: string[],
): void {
  if (plan.action !== 'authorization_resolution') return;
  if (!pending) {
    errors.push('authorization_resolution requires a pending authorization request');
    return;
  }
  if (plan.authorizationResolution?.requestId !== pending.requestId) {
    errors.push('authorization_resolution requestId must exactly match the pending request');
  }
  if (plan.task.binding !== 'reference' || plan.task.taskId !== pending.taskId) {
    errors.push('authorization_resolution must reference the pending request Task');
  }
}

function validateActionSemantics(plan: PlanningAgentPlan, errors: string[]): void {
  if (plan.action === 'clarification' && !plan.clarificationQuestion?.trim()) {
    errors.push('clarification requires clarificationQuestion');
  }
  if (plan.action === 'direct_reply' && !plan.response.directReply?.trim()) {
    errors.push('direct_reply requires a non-empty response.directReply');
  }
  if (plan.action === 'task_control' && plan.task.control === 'none') {
    errors.push('task_control requires a control kind');
  }
}

function validateTaskControlScope(plan: PlanningAgentPlan, errors: string[]): void {
  if (plan.action !== 'task_control') return;
  if (plan.task.control === 'status_query' && !['dashboard', 'blocked', 'running'].includes(plan.task.scope ?? '')) {
    errors.push('status_query requires scope dashboard, blocked, or running');
  }
  if (plan.task.control === 'clear_tasks' && !['all', 'parked', 'blocked'].includes(plan.task.scope ?? '')) {
    errors.push('clear_tasks requires scope all, parked, or blocked');
  }
  if (
    (plan.task.control === 'resume_task' || plan.task.control === 'recover_blocked')
    && plan.task.scope !== null
  ) {
    errors.push(`${plan.task.control} requires scope null`);
  }
}

function validateTaskPriority(plan: PlanningAgentPlan, errors: string[]): void {
  const schedulable = plan.action === 'plan_work_graph'
    || (plan.action === 'task_control'
      && (plan.task.control === 'resume_task' || plan.task.control === 'recover_blocked'));
  const priority = plan.task.priority;
  if (!schedulable) {
    if (priority !== null) errors.push('task.priority must be null for non-schedulable actions');
    return;
  }
  if (!priority || !TASK_PRIORITIES.has(priority.level) || !priority.reason.trim()) {
    errors.push('schedulable actions require task.priority with valid level and non-empty reason');
  }
}

function validateRouting(
  subtasks: SubtaskProposal[],
  configuration: PlannerConfigurationView,
  errors: string[],
): void {
  const catalog = configuration.routingCatalog;
  const capabilityIds = new Set(catalog.capabilities.map(capability => capability.id));
  const agentClassesByRef = new Map(catalog.agentClasses.map(agentClass => [agentClass.id, agentClass]));
  const modelRefs = new Set(configuration.models.map(model => model.id));

  for (const subtask of subtasks) {
    collectDuplicateErrors(
      subtask.id,
      'Routing Capability',
      subtask.requiredCapabilities,
      errors,
    );
    collectDuplicateErrors(
      subtask.id,
      'executor binding',
      subtask.executorBindings.map(executorBindingKey),
      errors,
    );

    if (subtask.requiredCapabilities.length === 0) {
      errors.push(`subtask ${subtask.id} requires at least one Routing Capability`);
    }
    if (subtask.executorBindings.length === 0) {
      errors.push(`subtask ${subtask.id} requires at least one executor binding`);
    }

    const unknownCapabilities = subtask.requiredCapabilities.filter(capability => !capabilityIds.has(capability));
    for (const capability of unknownCapabilities) {
      errors.push(`subtask ${subtask.id} references unknown Routing Capability: ${capability}`);
    }

    const required = new Set(subtask.requiredCapabilities);
    const eligible = catalog.agentClasses.filter(
      agentClass => [...required].every(capability =>
        agentClass.routingCapabilities.includes(capability)),
    );

    if (required.size > 0 && unknownCapabilities.length === 0 && eligible.length === 0) {
      errors.push(`no_capable_agent_class: subtask ${subtask.id} must be split at a Routing Capability handoff`);
    }

    for (const binding of subtask.executorBindings) {
      const agentClass = agentClassesByRef.get(binding.agentClassRef);
      if (!agentClass) {
        errors.push(
          `subtask ${subtask.id} references unavailable AgentClass in revision ${configuration.revisionId}: ${binding.agentClassRef}`,
        );
        continue;
      }
      const uncovered = [...required]
        .filter(capability => !agentClass.routingCapabilities.includes(capability))
        .sort();
      if (uncovered.length > 0) {
        errors.push(
          `subtask ${subtask.id} AgentClass ${binding.agentClassRef} does not cover required capabilities: ${uncovered.join(', ')}`,
        );
      }
      validateModelSelection(subtask.id, binding, agentClass, modelRefs, configuration.revisionId, errors);
    }
  }
}

function validateModelSelection(
  subtaskId: string,
  binding: SubtaskProposal['executorBindings'][number],
  agentClass: ConfigurationCatalogAgentClass,
  modelRefs: ReadonlySet<string>,
  configurationRevision: string,
  errors: string[],
): void {
  const selection = binding.modelSelection;
  const policy = agentClass.modelPolicy;

  if (policy.mode === 'fixed') {
    if (selection.mode !== 'fixed-by-agent-class') {
      errors.push(
        `subtask ${subtaskId} AgentClass ${binding.agentClassRef} uses fixed ModelPolicy and requires fixed-by-agent-class selection`,
      );
    } else {
      validateModelAvailability(
        subtaskId,
        policy.modelRef,
        modelRefs,
        configurationRevision,
        errors,
      );
    }
    return;
  }

  if (selection.mode === 'fixed-by-agent-class') {
    errors.push(
      `subtask ${subtaskId} AgentClass ${binding.agentClassRef} uses auto ModelPolicy and cannot use fixed-by-agent-class selection`,
    );
    return;
  }

  if (selection.mode === 'proposed') {
    validateModelAvailability(
      subtaskId,
      selection.modelRef,
      modelRefs,
      configurationRevision,
      errors,
    );
    if (!policy.allowedModelRefs.includes(selection.modelRef)) {
      errors.push(
        `subtask ${subtaskId} Model ${selection.modelRef} is not allowed by AgentClass ${binding.agentClassRef}`,
      );
    }
    return;
  }

  if (!policy.defaultModelRef) {
    errors.push(
      `subtask ${subtaskId} AgentClass ${binding.agentClassRef} has no default Model`,
    );
    return;
  }
  validateModelAvailability(
    subtaskId,
    policy.defaultModelRef,
    modelRefs,
    configurationRevision,
    errors,
  );
}

function validateModelAvailability(
  subtaskId: string,
  modelRef: string,
  modelRefs: ReadonlySet<string>,
  configurationRevision: string,
  errors: string[],
): void {
  if (!modelRefs.has(modelRef)) {
    errors.push(
      `subtask ${subtaskId} references unavailable Model in revision ${configurationRevision}: ${modelRef}`,
    );
  }
}

function executorBindingKey(
  binding: SubtaskProposal['executorBindings'][number],
): string {
  if (binding.modelSelection.mode === 'proposed') {
    return `${binding.agentClassRef}:${binding.modelSelection.mode}:${binding.modelSelection.modelRef}`;
  }
  return `${binding.agentClassRef}:${binding.modelSelection.mode}`;
}

function collectDuplicateErrors(
  subtaskId: string,
  label: string,
  values: readonly string[],
  errors: string[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) errors.push(`subtask ${subtaskId} contains duplicate ${label}: ${value}`);
    seen.add(value);
  }
}
