import { describe, expect, it } from 'vitest';
import { validatePlanningAgentPlan } from '../../src/planning/planning-agent-plan-validator.js';
import type { PlanningAgentPlan, SubtaskProposal, WorkGraphProposal } from '../../src/planning/planning-types.js';

function subtask(overrides: Partial<SubtaskProposal> = {}): SubtaskProposal {
  return {
    id: 'subtask_1',
    title: 'do the thing',
    goal: 'the goal',
    dependsOn: [],
    requiredAgentClassKind: 'executor',
    agentClassHint: null,
    candidateAgentClasses: ['codex-cli'],
    expectedOutput: 'patch',
    acceptance: ['ok'],
    riskLevel: 'low',
    ...overrides,
  };
}

function workGraphPlan(workGraph: WorkGraphProposal): PlanningAgentPlan {
  return plan({
    action: 'plan_work_graph',
    task: {
      ...plan().task,
      binding: 'new',
      title: 't',
      goal: 'g',
      priority: { level: 'normal', reason: 'test work graph priority' },
    },
    workGraph,
  });
}

function plan(overrides: Partial<PlanningAgentPlan> = {}): PlanningAgentPlan {
  return {
    id: 'plan_1',
    schemaVersion: 2,
    action: 'direct_reply',
    confidence: 0.9,
    reason: 'chat',
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
      priority: null,
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
    source: 'test',
    ...overrides,
  };
}

describe('validatePlanningAgentPlan', () => {
  it('accepts a valid direct reply plan', () => {
    expect(validatePlanningAgentPlan(plan())).toEqual({ valid: true, errors: [] });
  });

  it('rejects invalid JSON-shaped values and missing work graph fields', () => {
    expect(validatePlanningAgentPlan('not-json')).toMatchObject({ valid: false });
    expect(validatePlanningAgentPlan(plan({ action: 'plan_work_graph' }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['plan_work_graph requires workGraph']),
    });
  });

  it('rejects low-quality state-changing shapes before kernel policy runs', () => {
    expect(validatePlanningAgentPlan(plan({
      action: 'task_control',
      task: {
        ...plan().task,
        control: 'none',
      },
    }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['task_control requires a control kind']),
    });
  });

  it('rejects v1 plans without a compatibility read path', () => {
    expect(validatePlanningAgentPlan({ ...plan(), schemaVersion: 1 })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['schemaVersion must be 2']),
    });
  });

  it.each([
    { action: 'plan_work_graph' as const, control: 'none' as const },
    { action: 'task_control' as const, control: 'resume_task' as const },
    { action: 'task_control' as const, control: 'recover_blocked' as const },
  ])('requires priority for $action/$control', ({ action, control }) => {
    const planned = action === 'plan_work_graph'
      ? workGraphPlan({ reason: 'r', subtasks: [subtask()] })
      : plan({
          action,
          task: { ...plan().task, binding: 'reference', taskId: 'task_1', control },
        });
    planned.task.priority = null;

    expect(validatePlanningAgentPlan(planned)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        'schedulable actions require task.priority with valid level and non-empty reason',
      ]),
    });
  });

  it.each([
    'resume_task' as const,
    'recover_blocked' as const,
  ])('requires null scope for %s', (control) => {
    const task = {
      ...plan().task,
      binding: 'reference' as const,
      taskId: 'task_1',
      control,
      priority: { level: 'normal' as const, reason: 'resume selected task' },
    };

    expect(validatePlanningAgentPlan(plan({
      action: 'task_control',
      task: { ...task, scope: 'dashboard' },
    }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([`${control} requires scope null`]),
    });
    expect(validatePlanningAgentPlan(plan({
      action: 'task_control',
      task: { ...task, scope: null },
    }))).toEqual({ valid: true, errors: [] });
  });

  it('requires null priority and a valid scope for non-scheduling task controls', () => {
    const invalid = plan({
      action: 'task_control',
      task: {
        ...plan().task,
        control: 'clear_tasks',
        scope: 'unknown',
        priority: { level: 'urgent', reason: 'should not be accepted' },
      },
    });

    expect(validatePlanningAgentPlan(invalid)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        'clear_tasks requires scope all, parked, or blocked',
        'task.priority must be null for non-schedulable actions',
      ]),
    });
  });

  it.each([
    {
      label: 'single subtask',
      subtasks: [subtask()],
    },
    {
      label: 'linear DAG A->B->C',
      subtasks: [
        subtask({ id: 'a' }),
        subtask({ id: 'b', dependsOn: ['a'] }),
        subtask({ id: 'c', dependsOn: ['b'] }),
      ],
    },
    {
      label: 'diamond DAG',
      subtasks: [
        subtask({ id: 'a' }),
        subtask({ id: 'b', dependsOn: ['a'] }),
        subtask({ id: 'c', dependsOn: ['a'] }),
        subtask({ id: 'd', dependsOn: ['b', 'c'] }),
      ],
    },
  ])('accepts a valid work graph: $label', ({ subtasks }) => {
    expect(validatePlanningAgentPlan(workGraphPlan({ reason: 'r', subtasks })))
      .toEqual({ valid: true, errors: [] });
  });

  it.each([
    {
      label: 'dangling dependsOn',
      subtasks: [subtask({ id: 'a', dependsOn: ['ghost'] })],
      expected: 'subtask a depends on unknown subtask: ghost',
    },
    {
      label: 'self dependency',
      subtasks: [subtask({ id: 'a', dependsOn: ['a'] })],
      expected: 'subtask a depends on itself',
    },
    {
      label: 'two-node cycle',
      subtasks: [
        subtask({ id: 'a', dependsOn: ['b'] }),
        subtask({ id: 'b', dependsOn: ['a'] }),
      ],
      expected: 'workGraph.subtasks contains a dependency cycle',
    },
    {
      label: 'bad expectedOutput',
      subtasks: [subtask({ expectedOutput: 'nonsense' as SubtaskProposal['expectedOutput'] })],
      expected: 'subtask.expectedOutput is invalid: nonsense',
    },
    {
      label: 'bad requiredAgentClassKind',
      subtasks: [subtask({ requiredAgentClassKind: 'wizard' as SubtaskProposal['requiredAgentClassKind'] })],
      expected: 'subtask.requiredAgentClassKind is invalid: wizard',
    },
    {
      label: 'bad riskLevel',
      subtasks: [subtask({ riskLevel: 'nuclear' as SubtaskProposal['riskLevel'] })],
      expected: 'subtask.riskLevel is invalid: nuclear',
    },
  ])('rejects an invalid work graph: $label', ({ subtasks, expected }) => {
    expect(validatePlanningAgentPlan(workGraphPlan({ reason: 'r', subtasks }))).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expected]),
    });
  });
});
