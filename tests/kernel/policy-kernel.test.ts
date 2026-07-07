import { describe, expect, it } from 'vitest';
import type { AgentClass, Task, TaskStatus } from '../../src/core/types.js';
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

/** A task_control plan carries no work graph and a concrete control kind. */
function controlPlan(
  control: PlanningAgentPlan['task']['control'],
  taskOverrides: Partial<PlanningAgentPlan['task']> = {},
  overrides: Partial<PlanningAgentPlan> = {},
): PlanningAgentPlan {
  return plan({
    action: 'task_control',
    workGraph: null,
    task: { ...plan().task, binding: 'none', taskId: null, control, ...taskOverrides },
    ...overrides,
  });
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

describe('PolicyKernel executor availability', () => {
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

  // KNOWN LIMITATION (#5): the `.every(candidates.length > 0)` guard rejects a
  // whole multi-subtask graph if ANY single subtask loses all its executors,
  // and the selectedExecutor fallback only inspects subtasks[0]. The adapter
  // only emits single-subtask graphs today, so this is latent; this test pins
  // the current behavior so the future partial-dispatch fix has to update it.
  it('rejects a multi-subtask graph when only the first subtask loses its executors (#5, latent)', () => {
    const multi = plan({
      workGraph: {
        reason: 'multi',
        subtasks: [
          {
            id: 'subtask_a',
            title: 'a',
            goal: 'a',
            dependsOn: [],
            requiredAgentClassKind: 'executor',
            agentClassHint: 'unavailable-executor',
            candidateAgentClasses: ['unavailable-executor'],
            expectedOutput: 'summary',
            acceptance: [],
            riskLevel: 'low',
          },
          {
            id: 'subtask_b',
            title: 'b',
            goal: 'b',
            dependsOn: [],
            requiredAgentClassKind: 'executor',
            agentClassHint: 'available-executor',
            candidateAgentClasses: ['available-executor'],
            expectedOutput: 'summary',
            acceptance: [],
            riskLevel: 'low',
          },
        ],
      },
    });

    const decision = new PolicyKernel().decide(multi, snapshot());

    expect(decision.outcome).toBe('reject');
    expect(decision.reason).toContain('no available executor');
  });

  it.todo('should dispatch the satisfiable subtasks when only some lose their executors (#5)');
});

describe('PolicyKernel confidence gate', () => {
  // The low-confidence gate applies only to state-changing actions
  // (task_control, plan_work_graph) and uses a strict `< 0.45` threshold.
  // Parametrized over the boundary so an operator/threshold regression is caught.
  it.each([
    { action: 'plan_work_graph' as const, confidence: 0.44, expectClarify: true },
    { action: 'plan_work_graph' as const, confidence: 0.45, expectClarify: false },
    { action: 'task_control' as const, confidence: 0.44, expectClarify: true },
    { action: 'task_control' as const, confidence: 0.45, expectClarify: false },
    { action: 'direct_reply' as const, confidence: 0.01, expectClarify: false },
  ])('$action @ confidence $confidence -> clarify=$expectClarify', ({ action, confidence, expectClarify }) => {
    const planned = action === 'task_control'
      ? controlPlan('status_query', {}, { confidence })
      : action === 'direct_reply'
        ? plan({ action: 'direct_reply', workGraph: null, confidence, task: { ...plan().task, binding: 'none', control: 'none' } })
        : plan({ confidence });

    const decision = new PolicyKernel().decide(planned, snapshot());

    if (expectClarify) {
      expect(decision.outcome).toBe('clarify');
      expect(decision.runtimeAction).toBe('clarification');
    } else {
      expect(decision.outcome).not.toBe('clarify');
    }
  });

  it('strips the work graph and execution routing from a clarified low-confidence plan', () => {
    const decision = new PolicyKernel().decide(plan({ confidence: 0.3 }), snapshot());

    expect(decision.outcome).toBe('clarify');
    expect(decision.plan.action).toBe('clarification');
    expect(decision.plan.workGraph).toBeNull();
    expect(decision.plan.execution.mode).toBe('none');
    expect(decision.plan.execution.selectedExecutor).toBeNull();
    expect(decision.plan.execution.candidateExecutors).toEqual([]);
    expect(decision.plan.clarificationQuestion).toBeTruthy();
  });
});

describe('PolicyKernel non-executing actions', () => {
  it.each([
    { name: 'direct_reply', planned: plan({ action: 'direct_reply', workGraph: null }), runtimeAction: 'direct_reply', outcome: 'accept' },
    { name: 'no_action', planned: plan({ action: 'no_action', workGraph: null }), runtimeAction: 'no_action', outcome: 'accept' },
    {
      name: 'clarification',
      planned: plan({ action: 'clarification', workGraph: null, clarificationQuestion: 'which task?' }),
      runtimeAction: 'clarification',
      outcome: 'clarify',
    },
  ])('$name is authorized without executor policy', ({ planned, runtimeAction, outcome }) => {
    const decision = new PolicyKernel().decide(planned, snapshot());

    expect(decision.outcome).toBe(outcome);
    expect(decision.runtimeAction).toBe(runtimeAction);
    expect(decision.rejected).toBe(false);
  });
});

describe('PolicyKernel task-state policy', () => {
  it.each<TaskStatus>(['done', 'archived', 'cancelled'])(
    'rejects resuming a %s task into a fresh work graph', (status) => {
      const decision = new PolicyKernel().decide(
        plan({ task: { ...plan().task, binding: 'reference', taskId: 'task_old' } }),
        snapshot({ tasks: [task('task_old', status)] }),
      );

      expect(decision.outcome).toBe('reject');
      expect(decision.reason).toContain('cannot be resumed');
    },
  );

  it.each([
    { name: 'work graph', planned: plan({ task: { ...plan().task, binding: 'reference', taskId: 'ghost' } }) },
    { name: 'task control', planned: controlPlan('resume_task', { binding: 'reference', taskId: 'ghost' }) },
  ])('rejects a $name plan referencing a non-existent task', ({ planned }) => {
    const decision = new PolicyKernel().decide(planned, snapshot());

    expect(decision.outcome).toBe('reject');
    expect(decision.reason).toContain('task not found');
  });

  it('rejects a fresh work graph while another top-level task is running', () => {
    const running = task('task_running', 'running');
    const decision = new PolicyKernel().decide(plan(), snapshot({ tasks: [running], runningTask: running }));

    expect(decision.outcome).toBe('reject');
    expect(decision.reason).toContain('单活跃任务限制');
  });

  it.each(['resume_task', 'recover_blocked'] as const)(
    'forces clarification when %s has no explicit taskId (no runtime guessing)',
    (control) => {
      const decision = new PolicyKernel().decide(
        controlPlan(control),
        snapshot(),
      );

      expect(decision.outcome).toBe('clarify');
      expect(decision.runtimeAction).toBe('clarification');
      expect(decision.reason).toContain('explicit taskId');
    },
  );

  it('rejects resume_task referencing a non-existent task', () => {
    const decision = new PolicyKernel().decide(
      controlPlan('resume_task', { binding: 'reference', taskId: 'ghost' }),
      snapshot(),
    );

    expect(decision.outcome).toBe('reject');
    expect(decision.reason).toContain('task not found');
  });

  it.each(['status_query', 'clear_tasks'] as const)(
    'allows %s even while a task is running', (control) => {
      const running = task('task_1', 'running');
      const decision = new PolicyKernel().decide(
        controlPlan(control),
        snapshot({ tasks: [running], runningTask: running }),
      );

      expect(decision.outcome).toBe('accept');
      expect(decision.runtimeAction).toBe('task_control');
    },
  );
});
