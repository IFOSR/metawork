import { describe, expect, it, vi } from 'vitest';
import { CodexPlanningAgent } from '../../src/planning/codex-planning-agent.js';
import { validatePlanningAgentPlan } from '../../src/planning/planning-agent-plan-validator.js';
import type { PlanningContext } from '../../src/planning/planning-types.js';
import type { AgentClass } from '../../src/core/types.js';

function agentClass(overrides: Partial<AgentClass> = {}): AgentClass {
  return {
    name: 'codex-cli',
    kind: 'executor',
    domains: ['software'],
    capabilities: ['code_edit'],
    inputTypes: [],
    outputTypes: [],
    strengths: [],
    weaknesses: [],
    primaryUseCases: [],
    avoidUseCases: [],
    intentAffinity: {},
    riskLevel: 'medium',
    availability: 'available',
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
    ...overrides,
  };
}

function context(overrides: Partial<PlanningContext> = {}): PlanningContext {
  return {
    userInput: '实现一个功能',
    recentTasks: [],
    agentClasses: [agentClass()],
    defaultExecutorName: 'codex-cli',
    currentFocus: null,
    hints: [],
    allowDurableTask: true,
    allowFileModification: true,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function bridge(query: (prompt: string) => Promise<string>) {
  return { query: vi.fn(query) };
}

const MULTI_SUBTASK_JSON = JSON.stringify({
  action: 'plan_work_graph',
  confidence: 0.9,
  reason: '需要拆成两步',
  capabilityClass: 'code_edit',
  task: { binding: 'new', title: '重构', goal: '重构并测试' },
  execution: { mode: 'multi_executor', selectedExecutor: 'codex-cli', candidateExecutors: ['codex-cli'] },
  risk: { level: 'medium' },
  workGraph: {
    reason: '两步 DAG',
    subtasks: [
      {
        id: 'design', title: '设计', goal: '写设计', dependsOn: [],
        requiredAgentClassKind: 'executor', agentClassHint: 'codex-cli',
        candidateAgentClasses: ['codex-cli'], expectedOutput: 'analysis',
        acceptance: ['给出设计'], riskLevel: 'low',
      },
      {
        id: 'impl', title: '实现', goal: '按设计实现', dependsOn: ['design'],
        requiredAgentClassKind: 'executor', agentClassHint: 'codex-cli',
        candidateAgentClasses: ['codex-cli'], expectedOutput: 'patch',
        acceptance: ['列出改动并给测试输出'], riskLevel: 'medium',
      },
    ],
  },
});

describe('CodexPlanningAgent', () => {
  it('parses a multi-subtask DAG into a valid PlanningAgentPlan', async () => {
    const agent = new CodexPlanningAgent({ llmBridge: bridge(async () => MULTI_SUBTASK_JSON) });

    const result = await agent.plan(context());

    expect(result.source).toBe('codex-planner');
    expect(result.action).toBe('plan_work_graph');
    expect(result.workGraph?.subtasks.map(subtask => subtask.id)).toEqual(['design', 'impl']);
    expect(result.workGraph?.subtasks[1]!.dependsOn).toEqual(['design']);
    expect(result.workGraph?.subtasks[0]!.expectedOutput).toBe('analysis');
    expect(validatePlanningAgentPlan(result)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    { label: 'prose-wrapped JSON', wrap: (json: string) => `这是计划:\n${json}\n以上。` },
    { label: 'fenced JSON', wrap: (json: string) => '```json\n' + json + '\n```' },
  ])('extracts JSON from $label output', async ({ wrap }) => {
    const agent = new CodexPlanningAgent({ llmBridge: bridge(async () => wrap(MULTI_SUBTASK_JSON)) });

    const result = await agent.plan(context());

    expect(result.action).toBe('plan_work_graph');
    expect(result.workGraph?.subtasks).toHaveLength(2);
  });

  it('repairs invalid output on a second attempt', async () => {
    // First response has a dangling dependsOn (fails validation); second is valid.
    const badJson = JSON.stringify({
      action: 'plan_work_graph', confidence: 0.9, reason: 'x', capabilityClass: 'code_edit',
      task: { binding: 'new' }, execution: { mode: 'single_executor' }, risk: { level: 'low' },
      workGraph: {
        reason: 'bad', subtasks: [{
          id: 'a', title: 't', goal: 'g', dependsOn: ['nonexistent'],
          requiredAgentClassKind: 'executor', candidateAgentClasses: ['codex-cli'],
          expectedOutput: 'patch', acceptance: ['ok'], riskLevel: 'low',
        }],
      },
    });
    const query = vi.fn()
      .mockResolvedValueOnce(badJson)
      .mockResolvedValueOnce(MULTI_SUBTASK_JSON);
    const agent = new CodexPlanningAgent({ llmBridge: { query } });

    const result = await agent.plan(context());

    expect(query).toHaveBeenCalledTimes(2);
    expect(result.action).toBe('plan_work_graph');
    expect(validatePlanningAgentPlan(result)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    { label: 'invalid expectedOutput', bad: { expectedOutput: 'nonsense' } },
    { label: 'non-string expectedOutput', bad: { expectedOutput: 1 } },
    { label: 'invalid requiredAgentClassKind', bad: { requiredAgentClassKind: 'wizard' } },
    { label: 'invalid riskLevel', bad: { riskLevel: 'nuclear' } },
  ])('does not silently default a present-but-invalid enum ($label) — it rejects and repairs', async ({ bad }) => {
    const badJson = JSON.stringify({
      action: 'plan_work_graph', confidence: 0.9, reason: 'x', capabilityClass: 'code_edit',
      task: { binding: 'new' }, execution: { mode: 'single_executor' }, risk: { level: 'low' },
      workGraph: {
        reason: 'bad', subtasks: [{
          id: 'a', title: 't', goal: 'g', dependsOn: [],
          requiredAgentClassKind: 'executor', candidateAgentClasses: ['codex-cli'],
          expectedOutput: 'patch', acceptance: ['ok'], riskLevel: 'low',
          ...bad,
        }],
      },
    });
    const query = vi.fn()
      .mockResolvedValueOnce(badJson)
      .mockResolvedValueOnce(MULTI_SUBTASK_JSON);
    const agent = new CodexPlanningAgent({ llmBridge: { query } });

    const result = await agent.plan(context());

    // The invalid enum must NOT be silently coerced to a default on attempt 1;
    // it must fail validation and trigger the repair retry.
    expect(query).toHaveBeenCalledTimes(2);
    expect(validatePlanningAgentPlan(result)).toEqual({ valid: true, errors: [] });
  });

  it('defaults invalid top-level action without triggering repair when the resulting plan is valid', async () => {
    const invalidActionJson = JSON.stringify({
      action: 'nonsense',
      confidence: 0.7,
      reason: 'x',
      clarificationQuestion: 'What should MetaClaw do?',
      task: {},
      execution: {},
      risk: {},
    });
    const query = vi.fn().mockResolvedValue(invalidActionJson);
    const agent = new CodexPlanningAgent({ llmBridge: { query } });

    const result = await agent.plan(context());

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.action).toBe('clarification');
    expect(validatePlanningAgentPlan(result)).toEqual({ valid: true, errors: [] });
  });

  it('defaults missing code_edit subtask expectedOutput to patch', async () => {
    const missingExpectedOutputJson = JSON.stringify({
      action: 'plan_work_graph',
      confidence: 0.9,
      reason: 'x',
      capabilityClass: 'code_edit',
      task: { binding: 'new' },
      execution: { mode: 'single_executor' },
      risk: { level: 'low' },
      workGraph: {
        reason: 'one',
        subtasks: [{
          id: 'a', title: 't', goal: 'g', dependsOn: [],
          requiredAgentClassKind: 'executor', candidateAgentClasses: ['codex-cli'],
          acceptance: ['ok'], riskLevel: 'low',
        }],
      },
    });
    const query = vi.fn().mockResolvedValue(missingExpectedOutputJson);
    const agent = new CodexPlanningAgent({ llmBridge: { query } });

    const result = await agent.plan(context());

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.workGraph?.subtasks[0]!.expectedOutput).toBe('patch');
    expect(validatePlanningAgentPlan(result)).toEqual({ valid: true, errors: [] });
  });

  it('resolves capabilityClass from execution when the top-level field is absent', async () => {
    // No top-level capabilityClass — the resolver must fall back to
    // execution.capabilityClass before the action-based default.
    const executionCapabilityJson = JSON.stringify({
      action: 'plan_work_graph',
      confidence: 0.9,
      reason: 'x',
      task: { binding: 'new' },
      execution: { mode: 'single_executor', capabilityClass: 'code_edit' },
      risk: { level: 'low' },
      workGraph: {
        reason: 'one',
        subtasks: [{
          id: 'a', title: 't', goal: 'g', dependsOn: [],
          requiredAgentClassKind: 'executor', candidateAgentClasses: ['codex-cli'],
          acceptance: ['ok'], riskLevel: 'low',
        }],
      },
    });
    const query = vi.fn().mockResolvedValue(executionCapabilityJson);
    const agent = new CodexPlanningAgent({ llmBridge: { query } });

    const result = await agent.plan(context());

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.execution.capabilityClass).toBe('code_edit');
    // code_edit must flow through to the subtask expectedOutput cross-field default.
    expect(result.workGraph?.subtasks[0]!.expectedOutput).toBe('patch');
    expect(validatePlanningAgentPlan(result)).toEqual({ valid: true, errors: [] });
  });

  it('silently defaults a present-but-invalid top-level capabilityClass without triggering repair', async () => {
    // Unlike subtask enums, an invalid top-level capabilityClass must be
    // coerced to the action-based default (general) rather than rejected.
    const invalidCapabilityJson = JSON.stringify({
      action: 'plan_work_graph',
      confidence: 0.9,
      reason: 'x',
      capabilityClass: 'weird',
      task: { binding: 'new' },
      execution: { mode: 'single_executor' },
      risk: { level: 'low' },
      workGraph: {
        reason: 'one',
        subtasks: [{
          id: 'a', title: 't', goal: 'g', dependsOn: [],
          requiredAgentClassKind: 'executor', candidateAgentClasses: ['codex-cli'],
          expectedOutput: 'summary', acceptance: ['ok'], riskLevel: 'low',
        }],
      },
    });
    const query = vi.fn().mockResolvedValue(invalidCapabilityJson);
    const agent = new CodexPlanningAgent({ llmBridge: { query } });

    const result = await agent.plan(context());

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.execution.capabilityClass).toBe('general');
    expect(validatePlanningAgentPlan(result)).toEqual({ valid: true, errors: [] });
  });

  it('falls back conservatively when an invalid enum is never repaired', async () => {
    const badEnumJson = JSON.stringify({
      action: 'plan_work_graph', confidence: 0.9, reason: 'x', capabilityClass: 'code_edit',
      task: { binding: 'new' }, execution: { mode: 'single_executor' }, risk: { level: 'low' },
      workGraph: {
        reason: 'bad', subtasks: [{
          id: 'a', title: 't', goal: 'g', dependsOn: [],
          requiredAgentClassKind: 'executor', candidateAgentClasses: ['codex-cli'],
          expectedOutput: 'nonsense', acceptance: ['ok'], riskLevel: 'low',
        }],
      },
    });
    const agent = new CodexPlanningAgent({ llmBridge: bridge(async () => badEnumJson) });

    const result = await agent.plan(context());

    expect(result.action).toBe('direct_reply');
    expect(validatePlanningAgentPlan(result)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    { label: 'transport failure', query: async () => { throw new Error('spawn failed'); } },
    { label: 'unparseable output', query: async () => 'not json at all' },
    {
      label: 'never-valid output',
      query: async () => JSON.stringify({ action: 'plan_work_graph', confidence: 0.9, workGraph: null }),
    },
  ])('falls back to a conservative direct reply on $label', async ({ query }) => {
    const agent = new CodexPlanningAgent({ llmBridge: bridge(query) });

    const result = await agent.plan(context());

    expect(result.action).toBe('direct_reply');
    expect(result.source).toBe('codex-planner');
    expect(result.workGraph).toBeNull();
    expect(validatePlanningAgentPlan(result)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    { allowFileModification: true, expected: true },
    { allowFileModification: false, expected: false },
  ])('gates canModifyFiles on allowFileModification=$allowFileModification', async ({ allowFileModification, expected }) => {
    const fileEditJson = JSON.stringify({
      action: 'plan_work_graph', confidence: 0.9, reason: 'x', capabilityClass: 'code_edit',
      task: { binding: 'new' },
      execution: { mode: 'single_executor', selectedExecutor: 'codex-cli', candidateExecutors: ['codex-cli'], canModifyFiles: true },
      risk: { level: 'low' },
      workGraph: {
        reason: 'one', subtasks: [{
          id: 'a', title: 't', goal: 'g', dependsOn: [],
          requiredAgentClassKind: 'executor', candidateAgentClasses: ['codex-cli'],
          expectedOutput: 'patch', acceptance: ['ok'], riskLevel: 'low',
        }],
      },
    });
    const agent = new CodexPlanningAgent({ llmBridge: bridge(async () => fileEditJson) });

    const result = await agent.plan(context({ allowFileModification }));

    expect(result.execution.canModifyFiles).toBe(expected);
  });
});
