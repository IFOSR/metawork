import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagerAgent, MANAGER_PROPOSAL_TOOL, renderTurnPrompt } from '../../src/planning/manager-host/manager-agent.js';
import { PiRpcClient } from '../../src/planning/manager-host/rpc-client.js';
import type { ManagerTurnInput } from '../../src/planning/manager-host/protocol.js';

// P2-B3: the Manager runs as an upstream Pi RPC child. These tests pin the turn
// contract: one prompt in, one proposal out, reported usage collected, and every
// failure mapped to a typed error instead of a half answer.
const fixture = fileURLToPath(new URL('../fixtures/fake-pi-rpc.mjs', import.meta.url));
const agents: ManagerAgent[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
});

function agent(mode: string, extra: { timeoutMs?: number; env?: Record<string, string> } = {}) {
  const created = new ManagerAgent({
    command: process.execPath,
    args: [fixture],
    env: { ...process.env, FAKE_RPC_MODE: mode, ...extra.env },
    cwd: process.cwd(),
    turnTimeoutMs: extra.timeoutMs ?? 5_000,
    commandTimeoutMs: extra.timeoutMs ?? 5_000,
  });
  agents.push(created);
  return created;
}

function turn(overrides: Partial<ManagerTurnInput> = {}): ManagerTurnInput {
  return {
    conversationId: 'conversation-1',
    taskId: 'task-1',
    generationId: 'generation-1',
    goal: '检查仓库结构',
    context: ['用户：看一下 src 目录'],
    workspace: { root: process.cwd(), mode: 'read_only' },
    permissionProfileRef: 'engineering',
    configurationRevision: 'revision-1',
    model: { providerRef: 'official', modelRef: 'model-a' },
    tools: [MANAGER_PROPOSAL_TOOL, 'read'],
    ...overrides,
  };
}

describe('manager agent turn', () => {
  it('captures only final assistant text separately from the proposal and private reasoning', async () => {
    const result = await agent('valid-plan').plan(turn());
    expect(result.assistantReply).toBe('你好');
    expect(result.proposal).not.toHaveProperty('response');
  });
  it('returns the proposal from the proposal tool and the reported usage', async () => {
    const result = await agent('ok').plan(turn());
    expect(result.proposal).toMatchObject({ schemaVersion: 9 });
    expect(result.usage).toEqual([expect.objectContaining({
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 800,
      source: 'reported',
      providerRef: 'official',
      modelRef: 'model-a',
    })]);
  });

  it('marks usage unavailable when the provider reported nothing', async () => {
    const result = await agent('no-usage').plan(turn());
    expect(result.usage).toEqual([expect.objectContaining({
      inputTokens: null, outputTokens: null, source: 'unavailable',
    })]);
  });

  it('keeps the full input unknown when Pi explicitly reports a malformed cache count', async () => {
    const result = await agent('invalid-cache').plan(turn());
    expect(result.usage).toEqual([expect.objectContaining({
      inputTokens: null, outputTokens: 300, cacheReadTokens: null,
    })]);
  });

  it('fails when the turn settles without a proposal', async () => {
    const invalid = agent('no-proposal');
    await expect(invalid.plan(turn()))
      .rejects.toMatchObject({ code: 'manager_invalid_output' });
    expect(invalid.pid).toBeNull();
  });

  it('reports the provider failure instead of a bare "no proposal"', async () => {
    const failed = agent('provider-error');
    await expect(failed.plan(turn())).rejects.toThrow(
      /manager turn produced no proposal: 429: .*余额不足/u,
    );
    expect(failed.pid).toBeNull();
  });

  it('surfaces a proposal tool failure instead of accepting a partial plan', async () => {
    await expect(agent('tool-error').plan(turn()))
      .rejects.toThrow(/schema validation failed/u);
  });

  it('reports a rejected prompt as an invalid turn', async () => {
    await expect(agent('reject-prompt').plan(turn()))
      .rejects.toMatchObject({ code: 'manager_invalid_output', retryable: true });
  });

  it('times out a stuck turn and cleans up the process', async () => {
    const stuck = agent('hang', { timeoutMs: 200 });
    await expect(stuck.plan(turn())).rejects.toMatchObject({ code: 'manager_timeout' });
    expect(stuck.pid).toBeNull();
  });

  it('cancels through an abort signal', async () => {
    const slow = agent('hang');
    const controller = new AbortController();
    const pending = slow.plan(turn(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'manager_cancelled' });
  });

  it('cancels a queued turn without launching or cancelling the preceding turn', async () => {
    const slow = agent('hang');
    const active = slow.plan(turn()).catch(error => error);
    const controller = new AbortController();
    const queued = slow.plan(turn({ conversationId: 'conversation-2' }), { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'manager_cancelled' });
    await slow.close();
    expect(await active).toMatchObject({ code: 'manager_cancelled' });
    expect(slow.pid).toBeNull();
    await expect(slow.plan(turn())).rejects.toMatchObject({ code: 'manager_cancelled' });
  });

  it('does not reuse model call identities across Manager instances', async () => {
    const first = await agent('ok').plan(turn());
    const second = await agent('ok').plan(turn());
    expect(first.usage[0]!.callId).not.toBe(second.usage[0]!.callId);
  });

  it('refuses a missing workspace instead of falling back to the Server directory', async () => {
    const missing = agent('ok');
    await expect(missing.plan(turn({ workspace: { root: '/nonexistent/metawork/workspace', mode: 'read_only' } })))
      .rejects.toMatchObject({ code: 'manager_spawn_failed' });
    expect(missing.pid).toBeNull();
  });

  it('rejects a child that emits a non-JSON record', async () => {
    await expect(agent('invalid-json-record').plan(turn()))
      .rejects.toMatchObject({ code: 'manager_invalid_output' });
  });

  it('renders only Runtime-provided context and forbids side effects', () => {
    const prompt = renderTurnPrompt(turn());
    expect(prompt).toContain('检查仓库结构');
    expect(prompt).toContain('用户：看一下 src 目录');
    expect(prompt).toContain('只读');
    expect(prompt).toContain(MANAGER_PROPOSAL_TOOL);
    expect(prompt).toContain('Never edit files');
    expect(prompt).not.toContain('secret');
  });
});

describe('pi rpc client', () => {
  it('correlates concurrent commands by id', async () => {
    const client = new PiRpcClient({
      command: process.execPath,
      args: [fixture],
      env: { ...process.env, FAKE_RPC_MODE: 'ok' },
      cwd: process.cwd(),
      commandTimeoutMs: 5_000,
    });
    try {
      const [first, second] = await Promise.all([
        client.command({ type: 'prompt', message: 'a' }),
        client.command({ type: 'prompt', message: 'b' }),
      ]);
      expect(first).toMatchObject({ success: true, command: 'prompt' });
      expect(second).toMatchObject({ success: true, command: 'prompt' });
      expect(first.id).not.toBe(second.id);
    } finally {
      await client.close();
    }
  });

  it('fails pending commands when the child exits', async () => {
    const client = new PiRpcClient({
      command: process.execPath,
      args: ['-e', 'process.exit(2)'],
      env: process.env,
      cwd: process.cwd(),
      commandTimeoutMs: 5_000,
    });
    try {
      await expect(client.command({ type: 'prompt', message: 'a' }))
        .rejects.toMatchObject({ code: 'manager_process_exit' });
    } finally {
      await client.close();
    }
  });
});
