import type { PlannerExecutorCatalog } from '../executor/builtin-executor-catalog.js';
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
  executorCatalog: PlannerExecutorCatalog,
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

  if (plan.workGraph) {
    errors.push(...validateWorkGraph(plan.workGraph).map(
      violation => `${violation.code}: ${violation.path}: ${violation.message}`,
    ));
    validateRouting(plan.workGraph.subtasks, executorCatalog, errors);
  }

  return { valid: errors.length === 0, errors: errors.sort() };
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
  catalog: PlannerExecutorCatalog,
  errors: string[],
): void {
  const capabilityIds = new Set(catalog.capabilities.map(capability => capability.id));
  const executorsByName = new Map(catalog.executors.map(executor => [executor.name, executor]));

  for (const subtask of subtasks) {
    collectDuplicateErrors(
      subtask.id,
      'Routing Capability',
      subtask.requiredCapabilities,
      errors,
    );
    collectDuplicateErrors(
      subtask.id,
      'preferred AgentClass',
      subtask.preferredAgentClassList,
      errors,
    );

    if (subtask.requiredCapabilities.length === 0) {
      errors.push(`subtask ${subtask.id} requires at least one Routing Capability`);
    }
    if (subtask.preferredAgentClassList.length === 0) {
      errors.push(`subtask ${subtask.id} requires at least one preferred AgentClass`);
    }

    const unknownCapabilities = subtask.requiredCapabilities.filter(capability => !capabilityIds.has(capability));
    for (const capability of unknownCapabilities) {
      errors.push(`subtask ${subtask.id} references unknown Routing Capability: ${capability}`);
    }

    const required = new Set(subtask.requiredCapabilities);
    const eligible = catalog.executors
      .filter(executor => [...required].every(capability => executor.routingCapabilities.includes(capability)))
      .map(executor => executor.name)
      .sort();

    if (required.size > 0 && unknownCapabilities.length === 0 && eligible.length === 0) {
      errors.push(`no_capable_agent_class: subtask ${subtask.id} must be split at a Routing Capability handoff`);
    }

    for (const name of subtask.preferredAgentClassList) {
      const executor = executorsByName.get(name);
      if (!executor) {
        errors.push(`subtask ${subtask.id} references non-canonical AgentClass: ${name}`);
        continue;
      }
      const uncovered = [...required]
        .filter(capability => !executor.routingCapabilities.includes(capability))
        .sort();
      if (uncovered.length > 0) {
        errors.push(`subtask ${subtask.id} AgentClass ${name} does not cover required capabilities: ${uncovered.join(', ')}`);
      }
    }

    const actualSet = [...new Set(subtask.preferredAgentClassList)].sort();
    if (!sameValues(actualSet, eligible)) {
      errors.push(`subtask ${subtask.id} preferred AgentClass set must equal eligible canonical set: ${eligible.join(', ') || '(none)'}`);
    }
  }
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

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
