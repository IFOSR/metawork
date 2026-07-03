import { describe, expect, it } from 'vitest';
import type { AgentClass, Task } from '../../src/core/types.js';
import { PolicyKernel, type RuntimeSnapshot } from '../../src/kernel/policy-kernel.js';
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';

const now = '2026-07-03T00:00:00.000Z';

function task(id: string, status: Task['status'] = 'ready'): Task {
  return {
    id,
    title: id,
    goal: id,
    status,
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [],
    prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function agentClass(name: string, availability: AgentClass['availability']): AgentClass {
  return {
    name,
    kind: 'executor',
    domains: [],
    capabilities: [],
    inputTypes: [],
    outputTypes: [],
    strengths: [],
    weaknesses: [],
    primaryUseCases: [],
    avoidUseCases: [],
    intentAffinity: {},
    riskLevel: 'medium',
    availability,
    historicalSuccess: 0.5,
    harness: null,
    model: null,
    skills: [],
    mcpServers: [],
    plugins: [],
    runtimeCommand: null,
    runtimeArgs: [],
    runtimeCheckCommand: null,
    projectUrl: null,
  };
}

function plan(overrides: Partial<PlanningAgentPlan> = {}): PlanningAgentPlan {
  return {
    id: 'plan_1',
    schemaVersion: 1,
    action: 'plan_work_graph',
    confidence: 0.9,
    reason: 'execute',
    clarificationQuestion: null,
    response: { directReply: null },
    task: {
      binding: 'new',
      taskId: null,
      control: 'none',
      scope: null,
      title: 'task',
      goal: 'do task',
      includeRecentConversationContext: false,
    },
    execution: {
      mode: 'single_executor',
      complexity: 'simple',
      selectedExecutor: 'unavailable-executor',
      candidateExecutors: ['unavailable-executor', 'available-executor'],
      requiresVerification: true,
      canModifyFiles: true,
      requiresExternalGateway: false,
      capabilityClass: 'code_edit',
      matchedBoundary: ['repo_execution'],
    },
    risk: { level: 'medium', requiresConfirmation: false, reasons: [] },
    workGraph: {
      reason: 'single',
      subtasks: [{
        id: 'subtask_execute',
        title: 'execute',
        goal: 'do task',
        dependsOn: [],
        requiredAgentClassKind: 'executor',
        agentClassHint: 'unavailable-executor',
        candidateAgentClasses: ['unavailable-executor', 'available-executor'],
        expectedOutput: 'patch',
        acceptance: ['tests'],
        riskLevel: 'medium',
      }],
    },
    source: 'test',
    ...overrides,
  };
}

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    tasks: [],
    runningTask: null,
    agentClasses: [
      agentClass('unavailable-executor', 'unavailable'),
      agentClass('available-executor', 'available'),
    ],
    currentFocus: null,
    ...overrides,
  };
}

describe('PolicyKernel', () => {
  it('rewrites unavailable selected executors to available candidates', () => {
    const decision = new PolicyKernel().decide(plan(), snapshot());

    expect(decision.outcome).toBe('rewrite');
    expect(decision.runtimeAction).toBe('plan_work_graph');
    expect(decision.plan.execution.selectedExecutor).toBe('available-executor');
    expect(decision.plan.workGraph?.subtasks[0]?.candidateAgentClasses).toEqual(['available-executor']);
  });

  it('rejects work graphs with no available executor candidates', () => {
    const decision = new PolicyKernel().decide(plan(), snapshot({
      agentClasses: [agentClass('unavailable-executor', 'unavailable')],
    }));

    expect(decision.outcome).toBe('reject');
    expect(decision.runtimeAction).toBe('reject');
    expect(decision.reason).toContain('no available executor');
  });

  it('requires explicit control target while another task is running', () => {
    const decision = new PolicyKernel().decide(plan({
      action: 'task_control',
      task: {
        ...plan().task,
        binding: 'none',
        taskId: null,
        control: 'resume_task',
      },
      workGraph: null,
    }), snapshot({ tasks: [task('task_1', 'running')], runningTask: task('task_1', 'running') }));

    expect(decision.outcome).toBe('reject');
    expect(decision.reason).toContain('单活跃任务限制');
  });

  it('clarifies low confidence state-changing plans', () => {
    const decision = new PolicyKernel().decide(plan({ confidence: 0.3 }), snapshot());

    expect(decision.outcome).toBe('clarify');
    expect(decision.runtimeAction).toBe('clarification');
  });
});
