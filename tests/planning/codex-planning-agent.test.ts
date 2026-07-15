import { describe, expect, it, vi } from 'vitest';
import { CodexPlanningAgent } from '../../src/planning/codex-planning-agent.js';
import { validatePlanningAgentPlan } from '../../src/planning/planning-agent-plan-validator.js';
import type { PlanningContext } from '../../src/planning/planning-types.js';

function context(overrides: Partial<PlanningContext> = {}): PlanningContext {
  return {
    userInput: '实现一个功能',
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
    timeoutMs: 5_000,
    ...overrides,
  };
}

function runner(run: (prompt: string) => Promise<string>) {
  return {
    run: vi.fn(async (prompt: string) => ({
      output: await run(prompt),
      toolCalls: [],
      durationMs: 1,
    })),
  };
}

const VALID_PLAN = JSON.stringify({
  schemaVersion: 2,
  action: 'plan_work_graph',
  confidence: 0.9,
  reason: '需要执行',
  capabilityClass: 'code_edit',
  task: {
    binding: 'new',
    title: '重构',
    goal: '重构并测试',
    priority: { level: 'high', reason: '用户要求优先完成' },
  },
  execution: {
    mode: 'single_executor',
    selectedExecutor: 'codex-cli',
    candidateExecutors: ['codex-cli'],
    canModifyFiles: true,
  },
  risk: { level: 'medium', requiresConfirmation: false },
  workGraph: {
    reason: '单步执行',
    subtasks: [{
      id: 'impl',
      title: '实现',
      goal: '实现并测试',
      dependsOn: [],
      requiredAgentClassKind: 'executor',
      agentClassHint: 'codex-cli',
      candidateAgentClasses: ['codex-cli'],
      expectedOutput: 'patch',
      acceptance: ['测试通过'],
      riskLevel: 'medium',
    }],
  },
});

describe('CodexPlanningAgent', () => {
  it('includes initial long-term memory and conversation history in the startup prompt', async () => {
    let receivedPrompt = '';
    const agent = new CodexPlanningAgent({
      runner: runner(async prompt => {
        receivedPrompt = prompt;
        return VALID_PLAN;
      }),
    });

    await agent.plan(context({
      initialContext: {
        longTermMemories: [{
          id: 'pref_name',
          type: 'identity',
          scope: 'global',
          subject: null,
          content: '我的名字是咸蛋超人',
        }],
        conversationHistory: [{
          userInput: '暗号是什么？',
          systemOutput: '暗号是青鸟。',
          createdAt: '2026-07-15T00:00:00.000Z',
          source: 'session',
        }],
      },
    }));

    expect(receivedPrompt).toContain('我的名字是咸蛋超人');
    expect(receivedPrompt).toContain('暗号是青鸟。');
  });

  it('parses a v2 tool-grounded work graph and priority', async () => {
    const agent = new CodexPlanningAgent({ runner: runner(async () => VALID_PLAN) });
    const result = await agent.plan(context());

    expect(result.schemaVersion).toBe(2);
    expect(result.task.priority).toEqual({ level: 'high', reason: '用户要求优先完成' });
    expect(result.workGraph?.subtasks[0]?.id).toBe('impl');
    expect(validatePlanningAgentPlan(result)).toEqual({ valid: true, errors: [] });
  });

  it('repairs a schedulable plan that omitted priority', async () => {
    const invalid = JSON.stringify({
      ...JSON.parse(VALID_PLAN),
      task: { binding: 'new', title: 'x', goal: 'x', priority: null },
    });
    const run = runner(vi.fn()
      .mockResolvedValueOnce(invalid)
      .mockResolvedValueOnce(VALID_PLAN));
    const agent = new CodexPlanningAgent({ runner: run });

    const result = await agent.plan(context());

    expect(run.run).toHaveBeenCalledTimes(2);
    expect(result.action).toBe('plan_work_graph');
  });

  it.each([
    { label: 'transport failure', run: async () => { throw new Error('spawn failed'); } },
    { label: 'unparseable output', run: async () => 'not json' },
  ])('fails closed with a clarification on $label', async ({ run }) => {
    const agent = new CodexPlanningAgent({ runner: runner(run) });
    const result = await agent.plan(context());

    expect(result.action).toBe('clarification');
    expect(result.confidence).toBe(0);
    expect(result.task.priority).toBeNull();
    expect(validatePlanningAgentPlan(result)).toEqual({ valid: true, errors: [] });
  });

  it('returns the validated plan when audit finalization fails', async () => {
    const audit = {
      start: vi.fn(() => ({ id: 'planner_run_test' })),
      finish: vi.fn(() => { throw new Error('database is locked'); }),
    };
    const agent = new CodexPlanningAgent({
      runner: runner(async () => VALID_PLAN),
      audit,
    });

    const result = await agent.plan(context());

    expect(result.action).toBe('plan_work_graph');
    expect(audit.finish).toHaveBeenCalledWith(expect.objectContaining({
      id: 'planner_run_test',
      status: 'completed',
    }));
  });

  it.each([
    { label: 'transport failure', run: async () => { throw new Error('spawn failed'); } },
    { label: 'invalid output after repair', run: async () => 'not json' },
  ])('returns the fail-closed clarification when audit finalization fails after $label', async ({ run }) => {
    const audit = {
      start: vi.fn(() => ({ id: 'planner_run_test' })),
      finish: vi.fn(() => { throw new Error('database is locked'); }),
    };
    const agent = new CodexPlanningAgent({ runner: runner(run), audit });

    const result = await agent.plan(context());

    expect(result.action).toBe('clarification');
    expect(result.confidence).toBe(0);
    expect(audit.finish).toHaveBeenCalledWith(expect.objectContaining({
      id: 'planner_run_test',
      status: 'failed',
    }));
  });

  it('applies the host file-modification authorization boundary', async () => {
    const agent = new CodexPlanningAgent({ runner: runner(async () => VALID_PLAN) });
    const result = await agent.plan(context({
      permissions: {
        allowDurableTask: true,
        allowFileModification: false,
        allowExternalGateway: true,
      },
    }));

    expect(result.execution.canModifyFiles).toBe(false);
  });
});
