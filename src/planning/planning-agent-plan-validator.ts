import type { PlanningAgentPlan, PlanningAction, SubtaskProposal } from './planning-types.js';

export interface PlanningAgentPlanValidationResult {
  valid: boolean;
  errors: string[];
}

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
  if (plan.schemaVersion !== 1) errors.push('schemaVersion must be 1');
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
  if (plan.action === 'plan_work_graph') {
    if (!plan.workGraph) {
      errors.push('plan_work_graph requires workGraph');
    } else {
      validateWorkGraph(plan.workGraph.subtasks, errors);
    }
  }

  return { valid: errors.length === 0, errors };
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
  }
}
