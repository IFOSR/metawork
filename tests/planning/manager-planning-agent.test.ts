import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ManagerPlanningAgent,
  toHarnessUsageEvent,
  toManagerTurn,
} from '../../src/planning/manager-host/manager-planning-agent.js';
import { renderTurnPrompt } from '../../src/planning/manager-host/manager-agent.js';
import { resolveWorkspaceAdmission } from '../../src/control/workspace-execution-decision.js';
import { PlanningAgentPlanSchema } from '../../src/planning/planning-agent-plan-schema.js';
import { writesWorkspace } from '../../src/work-graph/workspace-effect.js';
import type { PlanningProposalSubmitter } from '../../src/planning/planning-agent.js';
import type { PlannerProposalResult } from '../../src/planning/planner-proposal.js';
import type { PlanningContext } from '../../src/planning/planning-types.js';
import type { NormalizedCapabilityRequest } from '../../src/resource/types.js';

// P2-B4: the Manager replaces the vendored Planner behind the existing
// `PlanningAgent` port. MetaWork still validates every proposal with the same
// Plan schema, and a validation rejection still gets bounded repair turns.
const fixture = fileURLToPath(new URL('../fixtures/fake-pi-rpc.mjs', import.meta.url));
const agents: ManagerPlanningAgent[] = [];

describe('Manager permission RPC', () => {
  const request: NormalizedCapabilityRequest = {
    id: 'request', fingerprint: 'fingerprint', taskId: 'task', generationId: 'generation', subtaskId: 'subtask',
    attemptId: 'attempt', agentClassName: 'pi', permissionProfileId: 'standard-agent',
    capability: 'logical_resource_operation', resource: 'resource', operation: 'inspect', reason: 'user requested inspection',
    suggestedScope: 'attempt', partition: { kind: 'logical', namespace: 'test', key: 'resource' }, distinctRequestOrdinal: 1,
  };
  it.each(['grant', 'deny', 'escalate'] as const)('returns a structured %s verdict and reports provider usage', async verdict => {
    const usage: unknown[] = [];
    const result = await agent(`permission-${verdict}`).judgePermission(context({ onUsage: event => usage.push(event) }), request);
    expect(result).toMatchObject({ verdict, grantedScope: 'once' });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ counters: expect.arrayContaining([
      expect.objectContaining({ metric: 'input', value: '17' }),
      expect.objectContaining({ metric: 'output', value: '6' }),
    ]) });
  });
  it('rejects an unknown model verdict', async () => {
    await expect(agent('permission-invalid').judgePermission(context(), request)).rejects.toThrow('manager_permission_invalid_output');
  });
  it('runs the runtime admission hook before permission model IO', async () => {
    const calls: string[] = [];
    const manager = agent('permission-grant', calls);
    await manager.judgePermission(context(), request);
    expect(calls).toEqual(['permission']);
  });
});

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
});

function agent(mode: string, beforeCalls: string[] = []) {
  const created = new ManagerPlanningAgent({
    command: process.execPath,
    args: [fixture],
    env: { ...process.env, FAKE_RPC_MODE: mode },
    cwd: process.cwd(),
    turnTimeoutMs: 5_000,
    resolveScope: () => ({
      workspaceRoot: process.cwd(),
      permissionProfileRef: 'engineering',
    }),
    beforeModelCall: async (_context, purpose) => { beforeCalls.push(purpose); },
  });
  agents.push(created);
  return created;
}

function context(overrides: Partial<PlanningContext> = {}): PlanningContext {
  return {
    userInput: '你好',
    request: { sessionId: 'session-1', conversationId: 'conversation-1', source: 'web' },
    pendingAuthorizationRequest: null,
    configuration: {
      revisionId: 'revision-1',
      contentHash: 'hash-1',
      models: [{ id: 'model-a', providerRef: 'official' } as never],
      routingCatalog: {} as never,
    },
    timeoutMs: 5_000,
    ...overrides,
  };
}

function submitter(results: PlannerProposalResult[]) {
  const calls: unknown[] = [];
  const usage: unknown[] = [];
  return {
    calls,
    usage,
    submitter: {
      async submit(plan: unknown) {
        calls.push(plan);
        const next = results[Math.min(calls.length - 1, results.length - 1)];
        if (!next) throw new Error('no scripted result');
        return next;
      },
      onUsage(event: unknown) { usage.push(event); },
    } satisfies PlanningProposalSubmitter,
  };
}

const accepted: PlannerProposalResult = {
  status: 'accepted',
  turnId: 'turn-1',
  submissionId: 'submission-1',
  planId: 'plan-1',
  outcome: 'no_action',
  displayText: '你好',
  taskId: null,
  kernel: null,
} as unknown as PlannerProposalResult;

const validationRejected: PlannerProposalResult = {
  status: 'rejected',
  turnId: 'turn-1',
  submissionId: 'submission-1',
  planId: null,
  rejectionType: 'validation',
  issues: ['workspaceIntent: plan_work_graph requires workspaceIntent'],
  kernel: null,
};

const kernelRejected: PlannerProposalResult = {
  status: 'rejected',
  turnId: 'turn-1',
  submissionId: 'submission-1',
  planId: 'plan-1',
  rejectionType: 'kernel',
  issues: ['capacity'],
  kernel: { decisionId: 'decision-1', action: 'wait_for_capacity', reason: 'busy' },
} as unknown as PlannerProposalResult;

describe('manager planning agent', () => {
  it('records provider calls even when the turn fails to submit a proposal', async () => {
    const recording = submitter([accepted]);
    await expect(agent('no-proposal').submit(context(), recording.submitter)).rejects.toThrow();
    expect(recording.usage).toHaveLength(1);
    expect(recording.usage[0]).toMatchObject({ counters: [
      { metric: 'input', value: '5' }, { metric: 'output', value: '2' },
    ] });
    expect(recording.calls).toEqual([]);
  });

  it('rejects an unavailable configured model instead of selecting another model', () => {
    const configured = context();
    expect(() => toManagerTurn({ ...configured, configuration: {
      ...configured.configuration,
      planner: { modelPolicy: { mode: 'fixed', modelRef: 'deleted-model' } } as never,
    } }, { workspaceRoot: process.cwd(), permissionProfileRef: 'engineering' }))
      .toThrow('manager_model_unavailable');
  });
  it('validates a Manager proposal with the product Plan schema', async () => {
    const plan = await agent('valid-plan').plan(context());
    expect(plan).toMatchObject({ schemaVersion: 9, action: 'no_action' });
  });

  it('hands a schema-invalid proposal to admission instead of killing the Turn', async () => {
    // The admission validator names the exact fields; submit() feeds them back
    // so the same Turn can repair the proposal.
    const rejected = submitter([{
      status: 'rejected',
      turnId: 'turn_1',
      submissionId: 'submission_1',
      planId: 'plan_invalid',
      rejectionType: 'validation',
      issues: ['action: Invalid input'],
      kernel: null,
    }]);
    const result = await agent('invalid-plan').submit(context(), rejected.submitter);
    expect(result.status).toBe('convergence_exhausted');
    // One repair attempt is expected: the rejection issues are fed back.
    expect(rejected.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('submits the validated plan through the existing submitter', async () => {
    const scripted = submitter([accepted]);
    const result = await agent('valid-plan').submit(context(), scripted.submitter);
    expect(result.status).toBe('accepted');
    expect(result).toMatchObject({ outcome: 'no_action', displayText: '你好' });
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]).toMatchObject({ action: 'no_action' });
  });

  it('plans deliverable work as a Conversation Git worktree write, never as a capability question', async () => {
    const userInput = '你基于你的逻辑，直接把这个服务给实现了吧。架构就用BS的方式。';
    const plan = PlanningAgentPlanSchema.parse(await agent('write-plan').plan(context({ userInput })));
    expect(plan.action).toBe('plan_work_graph');
    // A Manager that answers "can I write?" instead of planning the work puts a
    // system capability question in front of the user (2026-11-11 regression).
    expect(plan.clarificationQuestion).toBeNull();
    const graph = plan.workGraph!.subtasks;
    const writes = graph.some(subtask => writesWorkspace(subtask, graph));
    expect(writes).toBe(true);
    expect(resolveWorkspaceAdmission({
      intent: plan.workspaceIntent,
      facts: { targetWorkspace: { workspaceId: 'workspace_main', canonicalPath: '/Users/me/project' } },
      riskLevel: plan.risk.level,
      writes,
      declaredOutputPaths: graph.flatMap(subtask => subtask.fileOutputs ?? []),
    })).toMatchObject({
      status: 'resolved',
      admission: { kind: 'write', workspaceId: 'workspace_main' },
      decision: { executionMode: 'conversation_git' },
    });
    // The same turn's prompt carries the execution fact and no 只读 label.
    const prompt = renderTurnPrompt(toManagerTurn(context({ userInput }), {
      workspaceRoot: '/Users/me/project',
      permissionProfileRef: 'engineering',
    }));
    expect(prompt).not.toContain('只读');
    expect(prompt).toContain('execution writes:');
  });

  it('returns a Manager-owned final answer from certified Subtask context', async () => {
    const manager = agent('valid-summary');
    const usage: unknown[] = [];
    const answer = await manager.summarizeTask({
      conversationId: 'conversation-1', taskId: 'task-1', workspaceRoot: process.cwd(),
      userInput: '比较两个标记', configuration: context().configuration,
      results: [
        { title: 'first', content: 'MW-EXACT-20261111' },
        { title: 'second', content: 'MW-FINAL-20261111' },
      ],
      onUsage: event => usage.push(event),
    });
    expect(answer).toContain('分别用于精确验收和发布验收');
    expect(usage).toHaveLength(1);
  });

  it('accepts the answer when the model adds non-authoritative explanation fields', async () => {
    const answer = await agent('summary-extra-fields').summarizeTask({
      conversationId: 'conversation-1', taskId: 'task-1', workspaceRoot: process.cwd(),
      userInput: '比较两个标记', configuration: context().configuration,
      results: [{ title: 'first', content: 'MW-EXACT-20261111' },
        { title: 'second', content: 'MW-FINAL-20261111' }],
    });
    expect(answer).toBe('两个标记均存在，分别用于精确验收和发布验收。');
  });

  it('fails an empty native no-action reply instead of completing with a blank answer', async () => {
    const scripted = submitter([accepted]);
    await expect(agent('empty-reply').submit(context(), scripted.submitter))
      .rejects.toThrow('without a user reply');
  });

  it('reports usage from the Manager turn to the metering seam', async () => {
    const scripted = submitter([accepted]);
    await agent('valid-plan').submit(context(), scripted.submitter);
    expect(scripted.usage).toEqual([expect.objectContaining({
      counters: expect.arrayContaining([
        expect.objectContaining({ metric: 'input', value: '10' }),
        expect.objectContaining({ metric: 'output', value: '4' }),
      ]),
    })]);
  });

  it('repairs a validation rejection and stops after the bounded attempts', async () => {
    const repaired = submitter([validationRejected, accepted]);
    expect((await agent('valid-plan').submit(context(), repaired.submitter)).status).toBe('accepted');
    expect(repaired.calls).toHaveLength(2);

    const blocked = submitter([validationRejected]);
    const result = await agent('valid-plan').submit(context(), blocked.submitter);
    expect(result).toMatchObject({
      status: 'convergence_exhausted', reason: 'repeated_rejection',
      limit: 3, observed: 3, issues: validationRejected.issues,
    });
    // One initial attempt plus two repairs; never an unbounded loop.
    expect(blocked.calls).toHaveLength(3);
  });

  it('does not repair a kernel rejection', async () => {
    const scripted = submitter([kernelRejected]);
    expect((await agent('valid-plan').submit(context(), scripted.submitter)).status).toBe('rejected');
    expect(scripted.calls).toHaveLength(1);
  });

  it('maps Runtime-owned scope and usage without letting the Manager invent them', () => {
    const turn = toManagerTurn(context(), {
      workspaceRoot: '/tmp/ws',
      permissionProfileRef: 'restricted',
    }, ['fix the graph']);
    expect(turn).toMatchObject({
      conversationId: 'conversation-1',
      goal: '你好',
      workspace: { root: '/tmp/ws' },
      permissionProfileRef: 'restricted',
      configurationRevision: 'revision-1',
      model: { providerRef: 'official', modelRef: 'model-a' },
    });
    expect(turn.context.join('\n')).toContain('fix the graph');
    expect(turn.tools).toEqual(['read', 'ls', 'grep', 'find', 'read_metawork_context', 'submit_manager_proposal']);
  });

  it('passes a soft quota notice as Manager context without changing the plan contract', () => {
    const turn = toManagerTurn({
      ...context(),
      quotaNotice: {
        reason: 'hosted_quota_exhausted',
        usedTokens: '100',
        limit: 100,
        message: 'Included hosted allowance is exhausted.',
      },
    }, { workspaceRoot: '/tmp/ws', permissionProfileRef: 'restricted' });
    expect(turn.context.join('\n')).toContain('Included hosted allowance is exhausted.');
    expect(turn.context.join('\n')).toContain('Continue the requested work when possible');
  });

  it('records missing usage as missing instead of zero', () => {
    const event = toHarnessUsageEvent({
      callId: 'c1',
      providerRef: 'p',
      modelRef: 'm',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      source: 'unavailable',
    }, context());
    expect(event.counters).toEqual([]);
    expect(event.missing).toEqual([
      { resource: 'model_tokens', metric: 'input', unit: 'token' },
      { resource: 'model_tokens', metric: 'output', unit: 'token' },
    ]);
  });

  it('includes Pi cache reads and writes in canonical input without adding reasoning twice', () => {
    const event = toHarnessUsageEvent({
      callId: 'cached', providerRef: 'p', modelRef: 'm', source: 'reported',
      inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800,
      cacheWriteTokens: 100, reasoningTokens: 200,
    }, context());
    expect(event.counters).toEqual([
      { resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta', value: '2100' },
      { resource: 'model_tokens', metric: 'output', unit: 'token', kind: 'delta', value: '300' },
      { resource: 'model_tokens', metric: 'cache_read', unit: 'token', kind: 'delta', value: '800', subsetOf: 'input' },
      { resource: 'model_tokens', metric: 'cache_write', unit: 'token', kind: 'delta', value: '100', subsetOf: 'input' },
      { resource: 'model_tokens', metric: 'reasoning', unit: 'token', kind: 'delta', value: '200', subsetOf: 'output' },
    ]);
    expect(event.missing).toBeUndefined();
  });
});

describe('manager composition', () => {
  it('loads only the packaged extension and isolated roots', async () => {
    const { composeManagerPlanningAgent, resolveManagerExtensionPath } =
      await import('../../src/planning/manager-host/composition.js');
    const extension = resolveManagerExtensionPath();
    expect(extension).toMatch(/index\.ts$/u);
    const composed = composeManagerPlanningAgent({
      runtimeRoot: '/tmp/metawork-runtime',
      resolveScope: () => ({ workspaceRoot: '/tmp/ws', permissionProfileRef: 'engineering' }),
    });
    // Project-local AGENTS/skills/extensions must never shape planning, and the
    // Manager runs in its own sandbox directory instead of the user Workspace.
    expect(composed.args).toEqual([
      '--mode', 'rpc',
      '--no-approve',
      '--no-skills',
      '--no-extensions',
      '--extension', extension,
    ]);
    expect(composed.command).toMatch(/\/\.missing-tools\/pi$/u);
    expect(composed.environmentDropped).toBeInstanceOf(Array);
    await composed.planningAgent.close();
  });

  it('fails loudly when the packaged extension is missing', async () => {
    const { resolveManagerExtensionPath } = await import('../../src/planning/manager-host/composition.js');
    expect(() => resolveManagerExtensionPath('/nonexistent-module-root')).toThrow(/not found|build/u);
  });
});

describe('planning transport selection', () => {
  it('defaults to the packaged upstream Pi Manager transport', async () => {
    const { resolvePlanningTransport } = await import('../../src/planning/manager-host/transport-selection.js');
    expect(resolvePlanningTransport({})).toBe('upstream-pi');
  });

  it('keeps the vendored planner reachable only as an explicit opt-out', async () => {
    const { resolvePlanningTransport } = await import('../../src/planning/manager-host/transport-selection.js');
    expect(resolvePlanningTransport({ METAWORK_MANAGER_TRANSPORT: 'vendored-planner' }))
      .toBe('vendored-planner');
  });

  it('selects the upstream Pi Manager transport explicitly', async () => {
    const { resolvePlanningTransport } = await import('../../src/planning/manager-host/transport-selection.js');
    for (const value of ['upstream-pi', 'PI', 'manager']) {
      expect(resolvePlanningTransport({ METAWORK_MANAGER_TRANSPORT: value })).toBe('upstream-pi');
    }
  });

  it('refuses an unknown transport instead of guessing', async () => {
    const { resolvePlanningTransport } = await import('../../src/planning/manager-host/transport-selection.js');
    expect(() => resolvePlanningTransport({ METAWORK_MANAGER_TRANSPORT: 'anyfusion' }))
      .toThrow(/METAWORK_MANAGER_TRANSPORT/u);
  });
});

describe('manager MCP configuration', () => {
  it('writes an isolated mcp.json for the Manager', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { writeManagerMcpConfig, resolvePlannerMcpEntry } = await import('../../src/planning/manager-host/mcp-config.js');
    const dir = mkdtempSync(join(tmpdir(), 'manager-mcp-'));
    try {
      const config = writeManagerMcpConfig({
        configDir: dir,
        serverEntry: resolvePlannerMcpEntry(process.cwd()),
        env: { METAWORK_SESSION_ID: 'session-1' },
      });
      const written = JSON.parse(readFileSync(config.path, 'utf8'));
      expect(written.mcpServers.metawork).toMatchObject({
        command: process.execPath,
        args: [resolvePlannerMcpEntry(process.cwd())],
        env: { METAWORK_SESSION_ID: 'session-1' },
        enabled: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records the MCP config path when composing and skips it when absent', async () => {
    const { composeManagerPlanningAgent } = await import('../../src/planning/manager-host/composition.js');
    const composed = composeManagerPlanningAgent({
      runtimeRoot: '/tmp/metawork-runtime-mcp',
      resolveScope: () => ({ workspaceRoot: '/tmp/ws', permissionProfileRef: 'engineering' }),
    });
    // dist/planner-mcp.js exists in a built tree; when it does not, composition
    // must still work and simply omit the MCP server.
    const { existsSync } = await import('node:fs');
    if (existsSync(resolvePlannerMcpEntryForTest())) {
      expect(composed.mcpConfigPath).toMatch(/mcp\.json$/u);
    } else {
      expect(composed.mcpConfigPath).toBeUndefined();
    }
    await composed.planningAgent.close();
  });
});

function resolvePlannerMcpEntryForTest(): string {
  return process.cwd() + '/dist/planner-mcp.js';
}
