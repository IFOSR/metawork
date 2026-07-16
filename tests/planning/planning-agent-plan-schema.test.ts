import { describe, expect, it } from 'vitest';
import { getPlannerExecutorCatalog } from '../../src/executor/builtin-executor-catalog.js';
import {
  applyContextDefaults,
  PlanningAgentPlanOutputSchema,
  PlanningAgentPlanSchema,
} from '../../src/planning/planning-agent-plan-schema.js';
import { validatePlanningAgentPlan } from '../../src/planning/planning-agent-plan-validator.js';
import type { PlanningContext } from '../../src/planning/planning-types.js';

const CONTEXT: PlanningContext = {
  userInput: 'implement the requested change',
  initialContext: {
    longTermMemories: [],
    conversationHistory: [],
  },
  request: { sessionId: 'session_test', source: 'test' },
  permissions: {
    allowDurableTask: true,
    allowFileModification: true,
    allowExternalGateway: true,
  },
  executorCatalog: getPlannerExecutorCatalog(),
  timeoutMs: 5_000,
};

function outputPlan() {
  return {
    id: 'plan_1',
    schemaVersion: 2,
    action: 'plan_work_graph',
    confidence: 0.9,
    reason: 'work is required',
    clarificationQuestion: null,
    response: { directReply: null },
    task: {
      binding: 'new',
      taskId: null,
      control: 'none',
      scope: null,
      title: 'Implement change',
      goal: 'Implement and test the requested change',
      includeRecentConversationContext: false,
      priority: { level: 'normal', reason: 'normal scheduling' },
    },
    execution: {
      mode: 'single_executor',
      complexity: 'simple',
      selectedExecutor: 'codex-cli',
      candidateExecutors: ['codex-cli'],
      requiresVerification: true,
      canModifyFiles: true,
      requiresExternalGateway: false,
      capabilityClass: 'code_edit',
      matchedBoundary: [],
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    workGraph: {
      reason: 'single implementation step',
      subtasks: [{
        id: 'impl',
        title: 'Implement',
        goal: 'Implement and test',
        dependsOn: [],
        requiredAgentClassKind: 'executor',
        agentClassHint: 'codex-cli',
        candidateAgentClasses: ['codex-cli'],
        expectedOutput: 'patch',
        acceptance: ['tests pass'],
        riskLevel: 'low',
      }],
    },
    source: 'codex-planner',
  };
}

describe('PlanningAgent plan schemas', () => {
  it('coerces a malformed priority so the validator can return the domain error', () => {
    const valid = outputPlan();
    const parsed = PlanningAgentPlanSchema.safeParse({
      ...valid,
      task: {
        ...valid.task,
        priority: { level: 'normal' },
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const candidate = applyContextDefaults(parsed.data, CONTEXT);
    expect(validatePlanningAgentPlan(candidate)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        'schedulable actions require task.priority with valid level and non-empty reason',
      ]),
    });
  });

  it('rejects an empty work graph at the structured-output boundary', () => {
    const valid = outputPlan();
    const parsed = PlanningAgentPlanOutputSchema.safeParse({
      ...valid,
      workGraph: { ...valid.workGraph, subtasks: [] },
    });

    expect(parsed.success).toBe(false);
  });
});
