import type { AgentClassKind, AgentClassRiskLevel, Subtask } from '../core/types.js';
import type { PlanningAgentPlan, PlanningAction, SubtaskProposal } from './planning-types.js';

export interface PlanningAgentPlanValidationResult {
  valid: boolean;
  errors: string[];
}

const AGENT_CLASS_KINDS = new Set<AgentClassKind>(['planner', 'executor']);
const EXPECTED_OUTPUTS = new Set<Subtask['expectedOutput']>(['analysis', 'patch', 'artifact', 'review', 'summary']);
const RISK_LEVELS = new Set<AgentClassRiskLevel>(['low', 'medium', 'high']);
const TASK_PRIORITIES = new Set(['normal', 'high', 'urgent']);

const ACTIONS: PlanningAction[] = [
  'direct_reply',
  'clarification',
  'task_control',
  'plan_work_graph',
  'no_action',
];

export function validatePlanningAgentPlan(value: unknown): PlanningAgentPlanValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== 'object') {
    return { valid: false, errors: ['plan must be an object'] };
  }

  const plan = value as Partial<PlanningAgentPlan>;
  if (plan.schemaVersion !== 2) errors.push('schemaVersion must be 2');
  if (!plan.id || typeof plan.id !== 'string') errors.push('id must be a string');
  if (!plan.action || !ACTIONS.includes(plan.action)) errors.push('action is invalid');
  if (typeof plan.confidence !== 'number' || plan.confidence < 0 || plan.confidence > 1) {
    errors.push('confidence must be between 0 and 1');
  }
  if (typeof plan.reason !== 'string') errors.push('reason must be a string');
  if (!plan.task || typeof plan.task !== 'object') errors.push('task must be an object');
  if (!plan.execution || typeof plan.execution !== 'object') errors.push('execution must be an object');
  if (!plan.risk || typeof plan.risk !== 'object') errors.push('risk must be an object');
  if (plan.action === 'clarification' && !plan.clarificationQuestion) {
    errors.push('clarification requires clarificationQuestion');
  }
  if (plan.action === 'task_control' && plan.task?.control === 'none') {
    errors.push('task_control requires a control kind');
  }
  validateTaskControlScope(plan, errors);
  validateTaskPriority(plan, errors);
  if (plan.action === 'plan_work_graph') {
    if (!plan.workGraph) {
      errors.push('plan_work_graph requires workGraph');
    } else {
      validateWorkGraph(plan.workGraph.subtasks, errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateTaskControlScope(plan: Partial<PlanningAgentPlan>, errors: string[]): void {
  if (plan.action !== 'task_control' || !plan.task) return;
  if (plan.task.control === 'status_query' && !['dashboard', 'blocked', 'running'].includes(plan.task.scope ?? '')) {
    errors.push('status_query requires scope dashboard, blocked, or running');
  }
  if (plan.task.control === 'clear_tasks' && !['all', 'parked', 'blocked'].includes(plan.task.scope ?? '')) {
    errors.push('clear_tasks requires scope all, parked, or blocked');
  }
}

function validateTaskPriority(plan: Partial<PlanningAgentPlan>, errors: string[]): void {
  const schedulable = plan.action === 'plan_work_graph'
    || (plan.action === 'task_control'
      && (plan.task?.control === 'resume_task' || plan.task?.control === 'recover_blocked'));
  const priority = plan.task?.priority;
  if (!schedulable) {
    if (priority !== null && priority !== undefined) {
      errors.push('task.priority must be null for non-schedulable actions');
    }
    return;
  }
  if (!priority || !TASK_PRIORITIES.has(priority.level) || !priority.reason.trim()) {
    errors.push('schedulable actions require task.priority with valid level and non-empty reason');
  }
}

function validateWorkGraph(subtasks: unknown, errors: string[]): void {
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    errors.push('workGraph.subtasks must be a non-empty array');
    return;
  }

  const ids = new Set<string>();
  for (const rawSubtask of subtasks) {
    const subtask = rawSubtask as Partial<SubtaskProposal>;
    if (!subtask.id || typeof subtask.id !== 'string') errors.push('subtask.id must be a string');
    if (subtask.id && ids.has(subtask.id)) errors.push(`duplicate subtask id: ${subtask.id}`);
    if (subtask.id) ids.add(subtask.id);
    if (!subtask.title || typeof subtask.title !== 'string') errors.push('subtask.title must be a string');
    if (!subtask.goal || typeof subtask.goal !== 'string') errors.push('subtask.goal must be a string');
    if (!Array.isArray(subtask.dependsOn)) errors.push('subtask.dependsOn must be an array');
    if (!Array.isArray(subtask.candidateAgentClasses)) errors.push('subtask.candidateAgentClasses must be an array');
    if (!Array.isArray(subtask.acceptance)) errors.push('subtask.acceptance must be an array');
    if (subtask.requiredAgentClassKind !== undefined && !AGENT_CLASS_KINDS.has(subtask.requiredAgentClassKind)) {
      errors.push(`subtask.requiredAgentClassKind is invalid: ${String(subtask.requiredAgentClassKind)}`);
    }
    if (subtask.expectedOutput !== undefined && !EXPECTED_OUTPUTS.has(subtask.expectedOutput)) {
      errors.push(`subtask.expectedOutput is invalid: ${String(subtask.expectedOutput)}`);
    }
    if (subtask.riskLevel !== undefined && !RISK_LEVELS.has(subtask.riskLevel)) {
      errors.push(`subtask.riskLevel is invalid: ${String(subtask.riskLevel)}`);
    }
  }

  // dependsOn must reference known subtasks, and the graph must be acyclic —
  // otherwise the runtime's dependency-gated dispatch (findNextReadySubtask)
  // would silently stall on a subtask whose dependencies never complete.
  validateDependencyGraph(subtasks as Partial<SubtaskProposal>[], ids, errors);
}

function validateDependencyGraph(
  subtasks: Partial<SubtaskProposal>[],
  ids: Set<string>,
  errors: string[],
): void {
  const edges = new Map<string, string[]>();
  for (const subtask of subtasks) {
    if (!subtask.id || !Array.isArray(subtask.dependsOn)) continue;
    const deps: string[] = [];
    for (const dependencyId of subtask.dependsOn) {
      if (typeof dependencyId !== 'string' || !ids.has(dependencyId)) {
        errors.push(`subtask ${subtask.id} depends on unknown subtask: ${String(dependencyId)}`);
        continue;
      }
      if (dependencyId === subtask.id) {
        errors.push(`subtask ${subtask.id} depends on itself`);
        continue;
      }
      deps.push(dependencyId);
    }
    edges.set(subtask.id, deps);
  }

  if (hasCycle(edges)) {
    errors.push('workGraph.subtasks contains a dependency cycle');
  }
}

function hasCycle(edges: Map<string, string[]>): boolean {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();

  const visit = (node: string): boolean => {
    const current = state.get(node);
    if (current === VISITING) return true;
    if (current === DONE) return false;
    state.set(node, VISITING);
    for (const next of edges.get(node) ?? []) {
      if (visit(next)) return true;
    }
    state.set(node, DONE);
    return false;
  };

  for (const node of edges.keys()) {
    if (visit(node)) return true;
  }
  return false;
}
