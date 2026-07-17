import { describe, expect, it } from 'vitest';
import { getPlannerExecutorCatalog } from '../../src/executor/builtin-executor-catalog.js';
import { PolicyKernel, type RuntimeSnapshot } from '../../src/kernel/policy-kernel.js';
import { validatePlanningAgentPlan } from '../../src/planning/planning-agent-plan-validator.js';
import type { PlanningAgentPlan, SubtaskProposal } from '../../src/planning/planning-types.js';

function subtask(overrides: Partial<SubtaskProposal>): SubtaskProposal {
  return {
    id: 'implement',
    title: 'Implement',
    goal: 'Implement and verify the requested workspace change',
    dependencies: [],
    contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList: ['codex-cli'],
    expectedOutput: 'patch',
    acceptance: [{ key: 'verified', description: 'The change is implemented and verified', requiredEvidence: [] }],
    riskLevel: 'medium',
    ...overrides,
  };
}

function plan(subtasks: SubtaskProposal[]): PlanningAgentPlan {
  return {
    id: 'phase1_handoff',
    schemaVersion: 4,
    action: 'plan_work_graph',
    confidence: 0.95,
    reason: 'Route work by capability handoff',
    clarificationQuestion: null,
    response: { directReply: null },
    task: {
      binding: 'new', taskId: null, control: 'none', scope: null,
      title: 'Research then implement', goal: 'Use current evidence to implement a workspace change',
      includeRecentConversationContext: false,
      priority: { level: 'normal', reason: 'Normal implementation priority' },
    },
    risk: { level: 'medium', requiresConfirmation: false, reasons: [] },
    workGraph: { reason: 'A cross-capability handoff is required', subtasks },
    source: 'codex-planner',
  };
}

const snapshot: RuntimeSnapshot = {
  tasks: [],
  runningTask: null,
  agentClasses: [],
  executorCatalog: getPlannerExecutorCatalog(),
  executorStatuses: [],
  v4WorkGraphTaskIds: [],
  currentFocus: null,
};

describe('Phase 1 capability-minimal planning and authorization', () => {
  it('accepts a current-web-research to workspace-engineering handoff end to end', () => {
    const candidate = plan([
      subtask({
        id: 'research',
        title: 'Research current evidence',
        goal: 'Produce source-backed current findings',
        requiredCapabilities: ['current-web-research'],
        preferredAgentClassList: ['pi-agent'],
        expectedOutput: 'summary',
        acceptance: [{ key: 'sources', description: 'Findings include traceable sources', requiredEvidence: ['sources'] }],
      }),
      subtask({ dependencies: [{
        fromSubtaskId: 'research',
        requiredItems: [{ key: 'findings', type: 'text', description: 'source-backed findings' }],
      }] }),
    ]);

    expect(validatePlanningAgentPlan(candidate, getPlannerExecutorCatalog())).toEqual({ valid: true, errors: [] });
    expect(new PolicyKernel().decide(candidate, snapshot)).toMatchObject({
      outcome: 'accept',
      runtimeAction: 'plan_work_graph',
      rejected: false,
    });
  });

  it('rejects both an uncovered combined node and an invalid dependency contract', () => {
    const combined = plan([subtask({
      requiredCapabilities: ['current-web-research', 'workspace-engineering'],
      preferredAgentClassList: ['pi-agent', 'codex-cli'],
    })]);
    expect(validatePlanningAgentPlan(combined, getPlannerExecutorCatalog()).errors)
      .toContain('no_capable_agent_class: subtask implement must be split at a Routing Capability handoff');

    const invalidEdge = plan([
      subtask({ id: 'implement' }),
      subtask({ id: 'verify', title: 'Verify', dependencies: [{
        fromSubtaskId: 'missing',
        requiredItems: [{ key: 'result', type: 'text', description: 'result' }],
      }], expectedOutput: 'summary' }),
    ]);
    expect(new PolicyKernel().decide(invalidEdge, snapshot)).toMatchObject({ outcome: 'reject', rejected: true });
  });
});
