import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManagerEnvironment } from '../../src/planning/manager-host/environment.js';
import {
  MANAGER_HOST_PROTOCOL_VERSION,
  ManagerHostError,
  parseManagerResponse,
  type ManagerTurnInput,
} from '../../src/planning/manager-host/protocol.js';
import { ManagerProcessRunner } from '../../src/planning/manager-host/process-runner.js';

// P2-B2: the Manager runs as an isolated Pi process behind a versioned,
// bounded, cancellable protocol. These tests exercise every failure mode with a
// fake child so the contract is pinned without depending on a Pi install.
const fixture = fileURLToPath(new URL('../fixtures/fake-manager.mjs', import.meta.url));
const runners: ManagerProcessRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close();
});

function runner(mode: string, options: { timeoutMs?: number; extraEnv?: Record<string, string> } = {}) {
  const created = new ManagerProcessRunner({
    command: process.execPath,
    args: [fixture],
    env: { ...process.env, FAKE_MANAGER_MODE: mode, ...options.extraEnv },
    cwd: process.cwd(),
    defaultTimeoutMs: options.timeoutMs ?? 5_000,
    killGraceMs: 100,
  });
  runners.push(created);
  return created;
}

function turn(overrides: Partial<ManagerTurnInput> = {}): ManagerTurnInput {
  return {
    conversationId: 'conversation-1',
    taskId: 'task-1',
    generationId: 'generation-1',
    goal: '检查仓库结构',
    context: [],
    workspace: { root: '/tmp/workspace' },
    permissionProfileRef: 'engineering',
    configurationRevision: 'revision-1',
    model: { providerRef: 'official', modelRef: 'model-a' },
    tools: ['submit_plan'],
    ...overrides,
  };
}

describe('manager host process runner', () => {
  it('returns a proposal and the reported usage for a planning turn', async () => {
    const result = await runner('ok').plan(turn());
    expect(result.proposal).toMatchObject({ schemaVersion: 9 });
    expect(result.usage).toEqual([expect.objectContaining({
      inputTokens: 12, outputTokens: 3, source: 'reported',
    })]);
  });

  it('reports a protocol mismatch instead of accepting another version', async () => {
    await expect(runner('ok', { extraEnv: { FAKE_MANAGER_PROTOCOL: '2' } }).plan(turn()))
      .rejects.toMatchObject({ code: 'manager_protocol_mismatch' });
  });

  it('rejects non-JSON output as invalid', async () => {
    await expect(runner('garbage').plan(turn()))
      .rejects.toMatchObject({ code: 'manager_invalid_output' });
  });

  it('rejects an oversized answer instead of buffering it', async () => {
    const oversized = new ManagerProcessRunner({
      command: process.execPath,
      args: [fixture],
      env: { ...process.env, FAKE_MANAGER_MODE: 'oversized', FAKE_MANAGER_OVERSIZE: '4096' },
      cwd: process.cwd(),
      defaultTimeoutMs: 5_000,
      maxMessageBytes: 1024,
      killGraceMs: 100,
    });
    runners.push(oversized);
    await expect(oversized.plan(turn())).rejects.toMatchObject({ code: 'manager_response_too_large' });
  });

  it('times out a stuck turn and kills the process', async () => {
    const stuck = runner('hang', { timeoutMs: 150 });
    await expect(stuck.plan(turn())).rejects.toMatchObject({ code: 'manager_timeout' });
    expect(stuck.running).toBe(false);
  });

  it('cancels through an abort signal', async () => {
    const slow = runner('ok', { extraEnv: { FAKE_MANAGER_DELAY_MS: '5000' } });
    const controller = new AbortController();
    const pending = slow.plan(turn(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'manager_cancelled' });
  });

  it('fails pending work when the child exits', async () => {
    const exiting = runner('exit');
    await expect(exiting.plan(turn())).rejects.toMatchObject({ code: 'manager_process_exit' });
  });

  it('answers a ping without a model turn', async () => {
    await expect(runner('ok').ping()).resolves.toBeUndefined();
  });

  it('survives a restart after a failed turn', async () => {
    const flaky = runner('exit');
    await expect(flaky.plan(turn())).rejects.toMatchObject({ code: 'manager_process_exit' });
    // A new child is spawned on the next turn instead of a stale failure.
    await expect(flaky.plan(turn())).rejects.toBeInstanceOf(ManagerHostError);
  });

  it('hands the child only the MetaWork-owned home and explicit variables', async () => {
    const { env, dropped } = buildManagerEnvironment({
      managerHome: '/tmp/metawork-manager-home',
      configDir: '/tmp/metawork-manager-home/config',
      sessionDir: '/tmp/metawork-manager-home/sessions',
      explicit: { METAWORK_MANAGER_TEST_FLAG: 'yes' },
    }, {
      ...process.env,
      HOME: '/Users/someone',
      PI_CODING_AGENT_DIR: '/Users/someone/.pi/agent',
      PI_SOMETHING: 'leak',
      OPENAI_API_KEY: 'sk-leak',
      NODE_OPTIONS: '--experimental-leak',
    });
    expect(env).toMatchObject({
      HOME: '/tmp/metawork-manager-home',
      PI_CODING_AGENT_DIR: '/tmp/metawork-manager-home/config',
      PI_CODING_AGENT_SESSION_DIR: '/tmp/metawork-manager-home/sessions',
      METAWORK_MANAGER_HOST_PROTOCOL: '1',
      METAWORK_MANAGER_TEST_FLAG: 'yes',
    });
    // A personal Pi home or provider key must never leak into the Manager.
    expect(env.PI_SOMETHING).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    // Overridden variables are replaced, not "dropped"; the personal Pi home and
    // provider keys are dropped outright.
    expect(dropped).toEqual(expect.arrayContaining(['PI_SOMETHING', 'NODE_OPTIONS']));
    expect(dropped).not.toContain('HOME');
    expect(dropped).not.toContain('PI_CODING_AGENT_DIR');
  });

  it('the child observes the isolated environment', async () => {
    const { env } = buildManagerEnvironment({
      managerHome: '/tmp/metawork-manager-home',
      configDir: '/tmp/metawork-manager-home/config',
      sessionDir: '/tmp/metawork-manager-home/sessions',
      explicit: { METAWORK_MANAGER_TEST_FLAG: 'yes' },
    });
    const isolated = new ManagerProcessRunner({
      command: process.execPath,
      args: [fixture],
      env: { ...env, FAKE_MANAGER_MODE: 'env' },
      cwd: process.cwd(),
      defaultTimeoutMs: 5_000,
      killGraceMs: 100,
    });
    runners.push(isolated);
    const result = await isolated.plan(turn());
    expect(result.proposal).toEqual({
      env: {
        HOME: '/tmp/metawork-manager-home',
        PI_CODING_AGENT_DIR: '/tmp/metawork-manager-home/config',
        PI_CODING_AGENT_SESSION_DIR: '/tmp/metawork-manager-home/sessions',
        leakedProviderKey: null,
        leakedPiSetting: null,
        explicitOnly: 'yes',
      },
    });
  });

  it('parses responses independently of the process', () => {
    expect(parseManagerResponse(JSON.stringify({
      type: 'planned', protocolVersion: MANAGER_HOST_PROTOCOL_VERSION, requestId: 'r1', proposal: {},
    }))).toMatchObject({ type: 'planned', requestId: 'r1' });
    expect(() => parseManagerResponse('{')).toThrow(/not JSON/u);
    expect(() => parseManagerResponse(JSON.stringify({ type: 'planned', protocolVersion: 99, requestId: 'r1' })))
      .toThrow(/protocol mismatch/u);
    expect(() => parseManagerResponse(JSON.stringify({ type: 'planned', protocolVersion: 1 })))
      .toThrow(/requestId/u);
    expect(() => parseManagerResponse(JSON.stringify({ type: 'weird', protocolVersion: 1, requestId: 'r' })))
      .toThrow(/unknown manager response type/u);
  });

  it('normalizes usage that the provider did not report', () => {
    const response = parseManagerResponse(JSON.stringify({
      type: 'planned', protocolVersion: 1, requestId: 'r1', proposal: {},
      usage: [{ callId: 'c1', providerRef: 'p', modelRef: 'm' }],
    }));
    expect(response).toMatchObject({
      usage: [expect.objectContaining({
        inputTokens: null, outputTokens: null, source: 'unavailable',
      })],
    });
  });
});
