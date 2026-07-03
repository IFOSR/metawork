import { describe, expect, it } from 'vitest';
import { validatePlanningAgentPlan } from '../../src/planning/planning-agent-plan-validator.js';
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';

function plan(overrides: Partial<PlanningAgentPlan> = {}): PlanningAgentPlan {
  return {
    id: 'plan_1',
    schemaVersion: 1,
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
});
