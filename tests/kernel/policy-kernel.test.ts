import { describe, expect, it } from 'vitest';
import { PolicyKernel, type RuntimeSnapshot } from '../../src/kernel/policy-kernel.js';
import { getPlannerExecutorCatalog } from '../../src/executor/builtin-executor-catalog.js';
import type { PlanningAgentPlan, SubtaskProposal } from '../../src/planning/planning-types.js';
import type { Task } from '../../src/core/types.js';

function node(overrides: Partial<SubtaskProposal> = {}): SubtaskProposal {
  return {
    id: 'execute', title: 'Execute', goal: 'Do work', dependencies: [],
    contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'], preferredAgentClassList: ['codex-cli'],
    expectedOutput: 'patch',
    acceptance: [{ key: 'tests', description: 'tests pass', requiredEvidence: ['test result'] }],
    riskLevel: 'medium', ...overrides,
  };
}

function plan(subtasks = [node()]): PlanningAgentPlan {
  return {
    id: 'plan', schemaVersion: 4, action: 'plan_work_graph', confidence: 0.9, reason: 'work',
    clarificationQuestion: null, response: { directReply: null },
    task: {
      binding: 'new', taskId: null, control: 'none', scope: null, title: 'Task', goal: 'Goal',
      includeRecentConversationContext: false, priority: { level: 'normal', reason: 'normal' },
    },
    risk: { level: 'medium', requiresConfirmation: false, reasons: [] },
    workGraph: { reason: 'work', subtasks }, source: 'codex-planner',
  };
}

const snapshot: RuntimeSnapshot = {
  tasks: [], runningTask: null, agentClasses: [], executorCatalog: getPlannerExecutorCatalog(),
  executorStatuses: [], v4WorkGraphTaskIds: [], eligibleContextRefKeys: ['current_user_input'], currentFocus: null,
};

describe('PolicyKernel Work Graph v4 authorization', () => {
  it('accepts a structurally valid canonical graph', () => {
    expect(new PolicyKernel().decide(plan(), snapshot)).toMatchObject({ outcome: 'accept', runtimeAction: 'plan_work_graph' });
  });

  it('filters an unhealthy AgentClass and rejects exhaustion', () => {
    expect(new PolicyKernel().decide(plan(), {
      ...snapshot,
      executorStatuses: [{ agentClassName: 'codex-cli', classHealth: 'disabled', recentAttempts: [], updatedAt: '' }],
    })).toMatchObject({ outcome: 'reject', rejected: true });
  });

  it('clarifies unqualified context refs', () => {
    const candidate = plan([node({ contextRefs: [{ kind: 'preference', preferenceId: 'unknown' }] })]);
    expect(new PolicyKernel().decide(candidate, snapshot)).toMatchObject({ outcome: 'clarify', runtimeAction: 'clarification' });
  });

  it('rejects replacing an existing v4 graph', () => {
    const existing = {
      id: 'task_existing', title: 'Existing', goal: 'goal', status: 'parked', summary: '', snapshots: [],
      resources: [], artifacts: [], dependencies: [],
      prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
      injectedPreferences: [], lastSchedulingReason: '', lastInterruptionReason: '', interruptionCount: 0,
      createdAt: '', updatedAt: '',
    } satisfies Task;
    const candidate = plan();
    candidate.task = { ...candidate.task, binding: 'reference', taskId: existing.id };
    expect(new PolicyKernel().decide(candidate, {
      ...snapshot, tasks: [existing], v4WorkGraphTaskIds: [existing.id],
    })).toMatchObject({ outcome: 'reject', rejected: true });
  });

  it('rejects a same-layer preferred AgentClass conflict from shared Work Graph validation', () => {
    const dependency = {
      fromSubtaskId: 'root',
      requiredItems: [{ key: 'result', type: 'text' as const, description: 'root result' }],
    };
    const candidate = plan([
      node({ id: 'root' }),
      node({ id: 'left', dependencies: [dependency] }),
      node({ id: 'right', dependencies: [dependency] }),
    ]);

    const decision = new PolicyKernel().decide(candidate, snapshot);

    expect(decision).toMatchObject({ outcome: 'reject', rejected: true });
    expect(decision.reason).toContain('same_layer_preferred_conflict');
  });
});
