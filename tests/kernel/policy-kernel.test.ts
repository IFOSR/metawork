import { describe, expect, it } from 'vitest';
import type { AgentClass, Task } from '../../src/core/types.js';
import { getPlannerExecutorCatalog } from '../../src/executor/builtin-executor-catalog.js';
import type { KernelExecutorStatusProjection } from '../../src/kernel/executor-status-projection.js';
import { PolicyKernel, type RuntimeSnapshot } from '../../src/kernel/policy-kernel.js';
import type { PlanningAgentPlan, SubtaskProposal } from '../../src/planning/planning-types.js';

const now = '2026-07-16T00:00:00.000Z';

function task(id: string, status: Task['status'] = 'parked'): Task {
  return {
    id, title: id, goal: id, status, summary: '', snapshots: [], resources: [], artifacts: [], dependencies: [],
    prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    injectedPreferences: [], lastSchedulingReason: '', lastInterruptionReason: '', interruptionCount: 0,
    createdAt: now, updatedAt: now,
  };
}

function agentClass(name: string): AgentClass {
  return {
    name, kind: 'executor', domains: [], capabilities: [], inputTypes: [], outputTypes: [], strengths: [],
    weaknesses: [], primaryUseCases: [], avoidUseCases: [], intentAffinity: {}, riskLevel: 'medium', harness: null,
    model: null, skills: [], mcpServers: [], plugins: [], runtimeCommand: null, runtimeArgs: [],
    runtimeCheckCommand: null, projectUrl: null,
  };
}

function subtask(overrides: Partial<SubtaskProposal> = {}): SubtaskProposal {
  return {
    id: 'execute', title: 'Execute', goal: 'Do work', dependsOn: [],
    requiredCapabilities: ['workspace-engineering'], preferredAgentClassList: ['codex-cli'],
    expectedOutput: 'patch', acceptance: ['tests pass'], riskLevel: 'medium', ...overrides,
  };
}

function plan(subtasks = [subtask()], overrides: Partial<PlanningAgentPlan> = {}): PlanningAgentPlan {
  return {
    id: 'plan_1', schemaVersion: 3, action: 'plan_work_graph', confidence: 0.9, reason: 'execute',
    clarificationQuestion: null, response: { directReply: null },
    task: {
      binding: 'new', taskId: null, control: 'none', scope: null, title: 'Task', goal: 'Do work',
      includeRecentConversationContext: false, priority: { level: 'normal', reason: 'test priority' },
    },
    risk: { level: 'medium', requiresConfirmation: false, reasons: [] },
    workGraph: { reason: 'capability-minimal graph', subtasks }, source: 'codex-planner', ...overrides,
  };
}

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    tasks: [], runningTask: null, agentClasses: [agentClass('codex-cli'), agentClass('pi-agent')],
    executorCatalog: getPlannerExecutorCatalog(), executorStatuses: [], v3WorkGraphTaskIds: [], currentFocus: null,
    ...overrides,
  };
}

function status(agentClassName: string, classHealth: KernelExecutorStatusProjection['classHealth']): KernelExecutorStatusProjection {
  return { agentClassName, classHealth, recentAttempts: [], updatedAt: now };
}

function dualWorkspaceCatalog() {
  const catalog = getPlannerExecutorCatalog();
  return {
    ...catalog,
    executors: catalog.executors.map(executor => ({ ...executor, routingCapabilities: ['workspace-engineering'] as const })),
  };
}

describe('PolicyKernel v3 work-graph authorization', () => {
  it('accepts a statically valid canonical graph independently of database AgentClass rows', () => {
    const decision = new PolicyKernel().decide(plan(), snapshot({ agentClasses: [agentClass('custom-only')] }));
    expect(decision).toMatchObject({ outcome: 'accept', runtimeAction: 'plan_work_graph', rejected: false });
  });

  it('rejects Planner bypass attempts with custom AgentClasses or free-text capabilities', () => {
    const custom = plan([subtask({ preferredAgentClassList: ['custom-agent'] as never })]);
    expect(new PolicyKernel().decide(custom, snapshot())).toMatchObject({ outcome: 'reject' });

    const freeText = plan([subtask({ requiredCapabilities: ['database-free-text'] as never })]);
    expect(new PolicyKernel().decide(freeText, snapshot())).toMatchObject({ outcome: 'reject' });
  });

  it('filters error/disabled preferences in order and returns a legal rewrite', () => {
    const candidate = plan([subtask({ preferredAgentClassList: ['pi-agent', 'codex-cli'] })]);
    const decision = new PolicyKernel().decide(candidate, snapshot({
      executorCatalog: dualWorkspaceCatalog(),
      executorStatuses: [status('pi-agent', 'error'), status('codex-cli', 'unverified')],
    }));

    expect(decision).toMatchObject({ outcome: 'rewrite', runtimeAction: 'plan_work_graph' });
    expect(decision.plan.workGraph?.subtasks[0].preferredAgentClassList).toEqual(['codex-cli']);
  });

  it('rejects when health filtering exhausts a node', () => {
    const decision = new PolicyKernel().decide(plan(), snapshot({
      executorStatuses: [status('codex-cli', 'disabled')],
    }));
    expect(decision).toMatchObject({ outcome: 'reject', runtimeAction: 'reject' });
    expect(decision.reason).toContain('no healthy canonical AgentClass remains');
  });

  it('rejects a health rewrite that creates a same-layer preferred conflict', () => {
    const candidate = plan([
      subtask({ id: 'a', preferredAgentClassList: ['codex-cli', 'pi-agent'] }),
      subtask({ id: 'b', preferredAgentClassList: ['pi-agent', 'codex-cli'] }),
    ]);
    const decision = new PolicyKernel().decide(candidate, snapshot({
      executorCatalog: dualWorkspaceCatalog(), executorStatuses: [status('pi-agent', 'error')],
    }));
    expect(decision).toMatchObject({ outcome: 'reject' });
    expect(decision.reason).toContain('health rewrite requires replanning');
    expect(decision.reason).toContain('same_layer_preferred_conflict');
  });

  it('allows a migration task without a v3 graph but rejects replacement of an existing v3 graph', () => {
    const existing = task('task_existing');
    const referenced = plan([subtask()], {
      task: { ...plan().task, binding: 'reference', taskId: existing.id },
    });
    expect(new PolicyKernel().decide(referenced, snapshot({ tasks: [existing] }))).toMatchObject({ outcome: 'accept' });
    const decision = new PolicyKernel().decide(referenced, snapshot({
      tasks: [existing], v3WorkGraphTaskIds: [existing.id],
    }));
    expect(decision).toMatchObject({ outcome: 'reject' });
    expect(decision.reason).toContain('already has a v3 work graph');
  });
});
