import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PlannerProcessSupervisor } from '../../src/planning/planner-process-supervisor.js';

interface FakeProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function fakeProcess(): FakeProcess {
  const child = new EventEmitter() as FakeProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    queueMicrotask(() => {
      child.emit('exit', null, 'SIGTERM');
      child.emit('close', null, 'SIGTERM');
    });
    return true;
  });
  return child;
}

function completeRpcTurn(
  child: FakeProcess,
  expectedModel?: { provider: string; modelId: string },
): void {
  let inputBuffer = '';
  child.stdin.on('data', chunk => {
    inputBuffer += chunk.toString();
    let newline = inputBuffer.indexOf('\n');
    while (newline >= 0) {
      const request = JSON.parse(inputBuffer.slice(0, newline)) as {
        id: string;
        type: string;
      };
      inputBuffer = inputBuffer.slice(newline + 1);
      if (request.type === 'get_state') {
        child.stdout.write(`${JSON.stringify({
          type: 'response',
          command: 'get_state',
          success: true,
          id: request.id,
          data: {
            model: {
              provider: expectedModel?.provider ?? 'deepseek',
              id: expectedModel?.modelId ?? 'deepseek-v4-pro',
            },
          },
        })}\n`);
      } else {
        const result = {
          status: 'accepted',
          turnId: 'turn-1',
          submissionId: 'submission-1',
          planId: 'plan-1',
          outcome: 'proposal_validated',
          displayText: 'validated',
          taskId: null,
          kernel: null,
        };
        for (const event of [
          { type: 'response', command: 'prompt', success: true, id: request.id },
          {
            type: 'tool_execution_start',
            toolCallId: 'tool-1',
            toolName: 'submit_planning_proposal',
            args: { plan: { id: 'plan-1', schemaVersion: 8 } },
          },
          {
            type: 'tool_execution_end',
            toolCallId: 'tool-1',
            toolName: 'submit_planning_proposal',
            result: { details: result },
            isError: false,
          },
          { type: 'agent_end', messages: [] },
        ]) {
          child.stdout.write(`${JSON.stringify(event)}\n`);
        }
      }
      newline = inputBuffer.indexOf('\n');
    }
  });
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
}

describe('PlannerProcessSupervisor', () => {
  it('rejects a Planner RPC when its explicit Conversation owner disagrees with the context', async () => {
    const supervisor = new PlannerProcessSupervisor();

    await expect(supervisor.runRpcTurn({
      sessionId: 'planner-session-a',
      conversationId: 'conversation-b',
      prompt: 'plan this',
      context: {
        timeoutMs: 1_000,
        request: {
          sessionId: 'planner-session-a',
          conversationId: 'conversation-a',
          source: 'gateway',
        },
        configuration: { revisionId: 'revision-test' },
      } as never,
      purpose: 'validation',
    })).rejects.toThrow('Planner RPC conversationId must match PlanningContext');
  });

  it('uses the vendored Planner CLI for direct source-tree starts', async () => {
    const child = fakeProcess();
    completeRpcTurn(child);
    const spawn = vi.fn(() => child as never);
    const supervisor = new PlannerProcessSupervisor({
      plannerHome: join(tmpdir(), `planner-home-vendored-${process.pid}`),
      sessionDir: join(tmpdir(), `planner-session-vendored-${process.pid}`),
      spawn: spawn as never,
    });

    await supervisor.run('plan this', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-vendored', source: 'gateway' },
    } as never, 'kernel');

    expect(spawn.mock.calls[0]?.[0]).toBe(resolve(
      process.cwd(),
      'planner/AnyFusion-Pi/packages/coding-agent/dist/cli.js',
    ));
  });

  it('uses the revision-pinned Planner runtime instead of a legacy environment override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'planner-supervisor-revision-'));
    const generatedRoot = join(root, 'generated');
    const revisionHome = join(generatedRoot, 'revision-deepseek', 'planner');
    const sessionDir = join(root, 'planner-sessions');
    await mkdir(revisionHome, { recursive: true });
    const child = fakeProcess();
    completeRpcTurn(child);
    const spawn = vi.fn((_command: string, _args: string[], options: {
      env?: NodeJS.ProcessEnv;
    }) => child as never);
    const previousHome = process.env.METACLAW_PLANNER_HOME;
    process.env.METACLAW_PLANNER_HOME = join(root, 'legacy-kimi-home');

    try {
      const supervisor = new PlannerProcessSupervisor({
        command: '/release/planner',
        generatedRuntimeRoot: generatedRoot,
        sessionDir,
        expectedModel: {
          provider: 'deepseek',
          modelId: 'deepseek-v4-pro',
        },
        spawn: spawn as never,
      });

      await supervisor.run('plan this', {
        timeoutMs: 1_000,
        request: { sessionId: 'session-revision', source: 'gateway' },
        configuration: {
          revisionId: 'revision-deepseek',
        },
      } as never, 'kernel');

      expect(spawn).toHaveBeenCalledWith(
        '/release/planner',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            ANYFUSION_PLANNER_HOME: revisionHome,
            ANYFUSION_PLANNER_RPC_TIMEOUT_MS: '1000',
          }),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.METACLAW_PLANNER_HOME;
      else process.env.METACLAW_PLANNER_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('materializes a writable Planner home when the generated revision is immutable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'planner-supervisor-runtime-home-'));
    const generatedRoot = join(root, 'generated');
    const revisionHome = join(generatedRoot, 'revision-writable', 'planner');
    const plannerRuntimeRoot = join(root, 'planner-runtime');
    const sessionDir = join(root, 'planner-sessions');
    await mkdir(revisionHome, { recursive: true });
    await writeFile(join(revisionHome, 'agent.json'), '{"kind":"planner"}\n', 'utf8');
    await chmod(revisionHome, 0o555);

    const child = fakeProcess();
    completeRpcTurn(child);
    const spawn = vi.fn((_command: string, _args: string[], options: {
      env?: NodeJS.ProcessEnv;
    }) => child as never);
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      generatedRuntimeRoot: generatedRoot,
      plannerRuntimeRoot,
      sessionDir,
      expectedModel: {
        provider: 'deepseek',
        modelId: 'deepseek-v4-pro',
      },
      spawn: spawn as never,
    });

    try {
      await supervisor.run('plan this', {
        timeoutMs: 1_000,
        request: { sessionId: 'session-writable-home', source: 'gateway' },
        configuration: { revisionId: 'revision-writable' },
      } as never, 'kernel');

      const plannerHome = spawn.mock.calls[0]?.[2]?.env?.ANYFUSION_PLANNER_HOME;
      expect(plannerHome).toBe(join(plannerRuntimeRoot, 'revision-writable'));
      await mkdir(join(plannerHome!, 'trust.json.lock'));
    } finally {
      await chmod(join(revisionHome, 'agent.json'), 0o600);
      await chmod(revisionHome, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('checks the restored Planner model before sending the prompt', async () => {
    const child = fakeProcess();
    const commands: Array<Record<string, unknown>> = [];
    child.stdin.on('data', chunk => {
      const command = JSON.parse(chunk.toString().trim()) as Record<string, unknown>;
      commands.push(command);
      if (command.type === 'get_state') {
        child.stdout.write(`${JSON.stringify({
          type: 'response',
          command: 'get_state',
          success: true,
          id: command.id,
          data: {
            model: { provider: 'kimi', id: 'k3' },
          },
        })}\n`);
      }
    });
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      plannerHome: join(tmpdir(), `planner-home-model-check-${process.pid}`),
      sessionDir: join(tmpdir(), `planner-session-model-check-${process.pid}`),
      expectedModel: {
        provider: 'deepseek',
        modelId: 'deepseek-v4-pro',
      },
      spawn: (() => child as never) as never,
      shutdownGraceMs: 10,
    });

    const error = await supervisor.run('plan this', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-model-check', source: 'gateway' },
    } as never, 'kernel').catch(value => value as Error);

    expect(error.message).toContain(
      'Planner model binding mismatch: expected deepseek/deepseek-v4-pro, received kimi/k3',
    );
    expect(commands.map(command => command.type)).toEqual(['get_state']);
  });

  it('sends the prompt only after the restored Planner model matches', async () => {
    const child = fakeProcess();
    const commands: Array<Record<string, unknown>> = [];
    child.stdin.on('data', chunk => {
      const command = JSON.parse(chunk.toString().trim()) as Record<string, unknown>;
      commands.push(command);
      if (command.type === 'get_state') {
        child.stdout.write(`${JSON.stringify({
          type: 'response',
          command: 'get_state',
          success: true,
          id: command.id,
          data: {
            model: { provider: 'deepseek', id: 'deepseek-v4-pro' },
          },
        })}\n`);
        return;
      }
      if (command.type !== 'prompt') return;
      const result = {
        status: 'accepted',
        turnId: 'turn-model-match',
        submissionId: 'submission-model-match',
        planId: 'plan-model-match',
        outcome: 'proposal_validated',
        displayText: 'validated',
        taskId: null,
        kernel: null,
      };
      for (const event of [
        { type: 'response', command: 'prompt', success: true, id: command.id },
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-model-match',
          toolName: 'submit_planning_proposal',
          args: { plan: { id: 'plan-model-match', schemaVersion: 8 } },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-model-match',
          toolName: 'submit_planning_proposal',
          result: { details: result },
          isError: false,
        },
        { type: 'agent_end', messages: [] },
      ]) {
        child.stdout.write(`${JSON.stringify(event)}\n`);
      }
    });
    child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      plannerHome: join(tmpdir(), `planner-home-model-match-${process.pid}`),
      sessionDir: join(tmpdir(), `planner-session-model-match-${process.pid}`),
      expectedModel: {
        provider: 'deepseek',
        modelId: 'deepseek-v4-pro',
      },
      spawn: (() => child as never) as never,
    });

    await expect(supervisor.run('plan this', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-model-match', source: 'gateway' },
    } as never, 'kernel')).resolves.toMatchObject({
      submittedPlan: { id: 'plan-model-match' },
    });
    expect(commands.map(command => command.type)).toEqual(['get_state', 'prompt']);
  });

  it('sends multimodal images with the prompt command when provided', async () => {
    const child = fakeProcess();
    const commands: Array<Record<string, unknown>> = [];
    child.stdin.on('data', chunk => {
      const command = JSON.parse(chunk.toString().trim()) as Record<string, unknown>;
      commands.push(command);
      if (command.type === 'get_state') {
        child.stdout.write(`${JSON.stringify({
          type: 'response',
          command: 'get_state',
          success: true,
          id: command.id,
          data: { model: { provider: 'deepseek', id: 'deepseek-v4-pro' } },
        })}\n`);
        return;
      }
      if (command.type !== 'prompt') return;
      const result = {
        status: 'accepted',
        turnId: 'turn-images',
        submissionId: 'submission-images',
        planId: 'plan-images',
        outcome: 'proposal_validated',
        displayText: 'validated',
        taskId: null,
        kernel: null,
      };
      for (const event of [
        { type: 'response', command: 'prompt', success: true, id: command.id },
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-images',
          toolName: 'submit_planning_proposal',
          args: { plan: { id: 'plan-images', schemaVersion: 8 } },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-images',
          toolName: 'submit_planning_proposal',
          result: { details: result },
          isError: false,
        },
        { type: 'agent_end', messages: [] },
      ]) {
        child.stdout.write(`${JSON.stringify(event)}\n`);
      }
    });
    child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      plannerHome: join(tmpdir(), `planner-home-images-${process.pid}`),
      sessionDir: join(tmpdir(), `planner-session-images-${process.pid}`),
      expectedModel: { provider: 'deepseek', modelId: 'deepseek-v4-pro' },
      spawn: (() => child as never) as never,
    });

    await expect(supervisor.run('看图规划', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-images', source: 'gateway' },
      images: [{
        name: 'chart.png',
        mimeType: 'image/png',
        data: Buffer.from('fake-png').toString('base64'),
      }],
    } as never, 'kernel')).resolves.toMatchObject({
      submittedPlan: { id: 'plan-images' },
    });

    const promptCommand = commands.find(command => command.type === 'prompt');
    expect(promptCommand?.images).toEqual([
      { type: 'image', data: Buffer.from('fake-png').toString('base64'), mimeType: 'image/png' },
    ]);
  });

  it('accepts RPC message events that echo an image larger than 1 MiB', async () => {
    const child = fakeProcess();
    child.stdin.on('data', chunk => {
      const command = JSON.parse(chunk.toString().trim()) as {
        id: string;
        type: string;
      };
      if (command.type === 'get_state') {
        child.stdout.write(`${JSON.stringify({
          type: 'response',
          command: 'get_state',
          success: true,
          id: command.id,
          data: { model: { provider: 'deepseek', id: 'deepseek-v4-pro' } },
        })}\n`);
        return;
      }
      if (command.type !== 'prompt') return;

      const echoedImage = Buffer.alloc(900 * 1024, 0x5a).toString('base64');
      child.stdout.write(`${JSON.stringify({
        type: 'message_start',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '请分析图片' },
            { type: 'image', data: echoedImage, mimeType: 'image/jpeg' },
          ],
        },
      })}\n`);
      for (const event of [
        { type: 'response', command: 'prompt', success: true, id: command.id },
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-large-image',
          toolName: 'submit_planning_proposal',
          args: { plan: { id: 'plan-large-image', schemaVersion: 8 } },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-large-image',
          toolName: 'submit_planning_proposal',
          result: {
            details: {
              status: 'accepted',
              turnId: 'turn-large-image',
              submissionId: 'submission-large-image',
              planId: 'plan-large-image',
              outcome: 'proposal_validated',
              displayText: 'validated',
              taskId: null,
              kernel: null,
            },
          },
          isError: false,
        },
        { type: 'agent_end', messages: [] },
      ]) {
        child.stdout.write(`${JSON.stringify(event)}\n`);
      }
    });
    child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));

    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      plannerHome: join(tmpdir(), `planner-home-large-image-${process.pid}`),
      sessionDir: join(tmpdir(), `planner-session-large-image-${process.pid}`),
      expectedModel: { provider: 'deepseek', modelId: 'deepseek-v4-pro' },
      spawn: (() => child as never) as never,
    });

    await expect(supervisor.run('请分析图片', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-large-image', source: 'gateway' },
    } as never, 'kernel')).resolves.toMatchObject({
      submittedPlan: { id: 'plan-large-image' },
    });
  });

  it('fails closed when the exact revision Planner home is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'planner-supervisor-missing-revision-'));
    const spawn = vi.fn();
    const previousHome = process.env.METACLAW_PLANNER_HOME;
    process.env.METACLAW_PLANNER_HOME = join(root, 'legacy-kimi-home');

    try {
      const supervisor = new PlannerProcessSupervisor({
        command: '/release/planner',
        generatedRuntimeRoot: join(root, 'generated'),
        sessionDir: join(root, 'planner-sessions'),
        spawn: spawn as never,
      });

      await expect(supervisor.run('plan this', {
        timeoutMs: 1_000,
        request: { sessionId: 'session-missing-revision', source: 'gateway' },
        configuration: { revisionId: 'revision-deepseek' },
      } as never, 'kernel')).rejects.toThrow(
        'Planner runtime is unavailable for configuration revision revision-deepseek',
      );
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) delete process.env.METACLAW_PLANNER_HOME;
      else process.env.METACLAW_PLANNER_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a request revision that differs from the supervisor binding', async () => {
    const spawn = vi.fn();
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      plannerHome: join(tmpdir(), `planner-home-revision-mismatch-${process.pid}`),
      sessionDir: join(tmpdir(), `planner-session-revision-mismatch-${process.pid}`),
      configurationRevision: 'revision-deepseek',
      expectedModel: {
        provider: 'deepseek',
        modelId: 'deepseek-v4-pro',
      },
      spawn: spawn as never,
    });

    await expect(supervisor.run('plan this', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-revision-mismatch', source: 'gateway' },
      configuration: { revisionId: 'revision-other' },
    } as never, 'kernel')).rejects.toThrow(
      'Planner supervisor revision mismatch: expected revision-deepseek, received revision-other',
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('requires an expected model before running a revision-bound RPC turn', async () => {
    const spawn = vi.fn();
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      plannerHome: join(tmpdir(), `planner-home-expected-model-${process.pid}`),
      sessionDir: join(tmpdir(), `planner-session-expected-model-${process.pid}`),
      spawn: spawn as never,
    });

    await expect(supervisor.run('plan this', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-expected-model', source: 'gateway' },
      configuration: { revisionId: 'revision-deepseek' },
    } as never, 'kernel')).rejects.toThrow(
      'Planner expected model binding is required for configuration revision revision-deepseek',
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('injects the revision-authorized Provider environment after legacy env files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'planner-supervisor-env-'));
    const envFile = join(root, 'provider.env');
    await writeFile(
      envFile,
      'OPENAI_BASE_URL=https://api.kimi.example/v1\nOPENAI_API_KEY=legacy\n',
    );
    const child = fakeProcess();
    completeRpcTurn(child);
    const spawn = vi.fn((_command: string, _args: string[], options: {
      env?: NodeJS.ProcessEnv;
    }) => child as never);
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      plannerHome: join(root, 'planner-home'),
      sessionDir: join(root, 'planner-sessions'),
      databasePath: join(root, 'account', 'data', 'anyfusion.db'),
      configurationRoot: join(root, 'account', 'config'),
      envFile,
      runtimeEnvironment: {
        OPENAI_BASE_URL: 'https://api.deepseek.example/v1',
        OPENAI_API_KEY: 'deepseek-key',
      },
      spawn: spawn as never,
    });

    try {
      await supervisor.run('plan this', {
        timeoutMs: 1_000,
        request: { sessionId: 'session-env', source: 'gateway' },
      } as never, 'kernel');

      expect(spawn.mock.calls[0]?.[2].env).toMatchObject({
        OPENAI_BASE_URL: 'https://api.deepseek.example/v1',
        OPENAI_API_KEY: 'deepseek-key',
        METACLAW_DB_PATH: join(root, 'account', 'data', 'anyfusion.db'),
        ANYFUSION_ACCOUNT_CONFIG_ROOT: join(root, 'account', 'config'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('streams safe lifecycle and tool progress while the RPC turn is still running', async () => {
    const child = fakeProcess();
    child.stdin.on('data', chunk => {
      const request = JSON.parse(chunk.toString().trim()) as { id: string };
      const result = {
        status: 'accepted',
        turnId: 'turn-progress',
        submissionId: 'submission-progress',
        planId: 'plan-progress',
        outcome: 'proposal_validated',
        displayText: 'validated',
        taskId: null,
        kernel: null,
      };
      for (const event of [
        { type: 'response', command: 'prompt', success: true, id: request.id },
        { type: 'agent_start' },
        { type: 'turn_start' },
        { type: 'message_start', message: { role: 'assistant', content: [] } },
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-context',
          toolName: 'get_planning_context',
          args: { section: 'task', secret: 'must-not-stream' },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-context',
          toolName: 'get_planning_context',
          result: { status: 'ok', content: 'must-not-stream' },
          isError: false,
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-submit',
          toolName: 'submit_planning_proposal',
          args: { plan: { id: 'plan-progress', schemaVersion: 8 } },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-submit',
          toolName: 'submit_planning_proposal',
          result: { details: result },
          isError: false,
        },
        { type: 'agent_end', messages: [] },
      ]) {
        child.stdout.write(`${JSON.stringify(event)}\n`);
      }
    });
    child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      sessionDir: join(tmpdir(), `planner-supervisor-progress-${process.pid}`),
      spawn: (() => child as never) as never,
    });
    const progress: Array<Record<string, unknown>> = [];

    await supervisor.run('plan this', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-progress', source: 'gateway' },
    } as never, 'kernel', event => progress.push(event as unknown as Record<string, unknown>));

    expect(progress.map(event => event.kind)).toEqual([
      'process_started',
      'prompt_accepted',
      'agent_started',
      'turn_started',
      'model_stream_started',
      'tool_started',
      'tool_completed',
      'tool_started',
      'tool_completed',
      'agent_completed',
    ]);
    expect(progress.find(event => event.kind === 'tool_started')).toMatchObject({
      toolName: 'get_planning_context',
      argumentFields: ['section'],
    });
    expect(JSON.stringify(progress)).not.toContain('must-not-stream');
    expect(JSON.stringify(progress)).not.toContain('"secret"');
  });

  it('streams bounded model-wait heartbeats before the RPC deadline', async () => {
    const child = fakeProcess();
    child.stdin.on('data', chunk => {
      const request = JSON.parse(chunk.toString().trim()) as { id: string };
      child.stdout.write(`${JSON.stringify({
        type: 'response',
        command: 'prompt',
        success: true,
        id: request.id,
      })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'agent_start' })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'turn_start' })}\n`);
      child.stdout.write(`${JSON.stringify({
        type: 'message_start',
        message: { role: 'assistant', content: [] },
      })}\n`);
    });
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      sessionDir: join(tmpdir(), `planner-supervisor-heartbeat-${process.pid}`),
      spawn: (() => child as never) as never,
      progressHeartbeatMs: 10,
      shutdownGraceMs: 10,
    });
    const progress: Array<Record<string, unknown>> = [];

    await expect(supervisor.run('plan this', {
      timeoutMs: 80,
      request: { sessionId: 'session-heartbeat', source: 'gateway' },
    } as never, 'kernel', event => progress.push(event as unknown as Record<string, unknown>)))
      .rejects.toThrow('AnyFusion Planner RPC timed out after 80ms');

    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'model_waiting',
        turn: 1,
        idleMs: expect.any(Number),
      }),
    ]));
  });

  it('terminates a Planner turn that exceeds the processing-cycle convergence budget', async () => {
    const child = fakeProcess();
    child.stdin.on('data', chunk => {
      const request = JSON.parse(chunk.toString().trim()) as { id: string };
      child.stdout.write(`${JSON.stringify({
        type: 'response',
        command: 'prompt',
        success: true,
        id: request.id,
      })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'agent_start' })}\n`);
      for (let cycle = 0; cycle < 3; cycle += 1) {
        child.stdout.write(`${JSON.stringify({ type: 'turn_start' })}\n`);
      }
    });
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      sessionDir: join(tmpdir(), `planner-supervisor-cycle-budget-${process.pid}`),
      spawn: (() => child as never) as never,
      maxProcessingCycles: 2,
      shutdownGraceMs: 10,
    });

    await expect(supervisor.run('plan this', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-cycle-budget', source: 'gateway' },
    } as never, 'kernel')).rejects.toThrow(
      'Planner did not submit a proposal within 2 processing cycles',
    );
    expect(child.kill).toHaveBeenCalled();
  });

  it('terminates a Planner turn that exceeds the non-proposal tool budget', async () => {
    const child = fakeProcess();
    child.stdin.on('data', chunk => {
      const request = JSON.parse(chunk.toString().trim()) as { id: string };
      child.stdout.write(`${JSON.stringify({
        type: 'response',
        command: 'prompt',
        success: true,
        id: request.id,
      })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'agent_start' })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'turn_start' })}\n`);
      for (let tool = 0; tool < 3; tool += 1) {
        child.stdout.write(`${JSON.stringify({
          type: 'tool_execution_start',
          toolCallId: `tool-${tool}`,
          toolName: 'read',
          args: { path: `/workspace/file-${tool}.ts` },
        })}\n`);
      }
    });
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      sessionDir: join(tmpdir(), `planner-supervisor-tool-budget-${process.pid}`),
      spawn: (() => child as never) as never,
      maxNonProposalToolCalls: 2,
      shutdownGraceMs: 10,
    });

    await expect(supervisor.run('plan this', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-tool-budget', source: 'gateway' },
    } as never, 'kernel')).rejects.toThrow(
      'Planner did not submit a proposal within 2 non-proposal tool calls',
    );
    expect(child.kill).toHaveBeenCalled();
  });

  it('returns a structured transport uncertainty instead of replacing it with a generic error', async () => {
    const child = fakeProcess();
    child.stdin.on('data', chunk => {
      const request = JSON.parse(chunk.toString().trim()) as { id: string };
      const result = {
        status: 'transport_uncertain',
        turnId: 'turn-uncertain',
        submissionId: 'submission-uncertain',
        retryableByReplay: true,
        message: 'connect ENOENT /tmp/anyfusion-planner.sock',
      };
      for (const event of [
        { type: 'response', command: 'prompt', success: true, id: request.id },
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-uncertain',
          toolName: 'submit_planning_proposal',
          args: { plan: { id: 'plan-uncertain', schemaVersion: 8 } },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-uncertain',
          toolName: 'submit_planning_proposal',
          result: { details: result },
          isError: true,
        },
        { type: 'agent_end', messages: [] },
      ]) {
        child.stdout.write(`${JSON.stringify(event)}\n`);
      }
    });
    child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      sessionDir: join(tmpdir(), `planner-supervisor-uncertain-${process.pid}`),
      spawn: (() => child as never) as never,
    });

    await expect(supervisor.run('plan this', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-uncertain', source: 'gateway' },
    } as never, 'kernel')).resolves.toMatchObject({
      proposalResult: {
        status: 'transport_uncertain',
        turnId: 'turn-uncertain',
        submissionId: 'submission-uncertain',
        retryableByReplay: true,
        message: 'connect ENOENT /tmp/anyfusion-planner.sock',
      },
      submittedPlan: { id: 'plan-uncertain', schemaVersion: 8 },
      toolCalls: [{
        sequence: 1,
        toolName: 'submit_planning_proposal',
        status: 'failed',
      }],
    });
  });

  it('stops the Pi RPC turn immediately after transport uncertainty', async () => {
    const child = fakeProcess();
    let agentEndWritten = false;
    child.stdin.on('data', chunk => {
      const request = JSON.parse(chunk.toString().trim()) as { id: string };
      const result = {
        status: 'transport_uncertain',
        turnId: 'turn-fast-fail',
        submissionId: 'submission-fast-fail',
        retryableByReplay: true,
        message: 'kernel persistence failed',
      };
      for (const event of [
        { type: 'response', command: 'prompt', success: true, id: request.id },
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-fast-fail',
          toolName: 'submit_planning_proposal',
          args: { plan: { id: 'plan-fast-fail', schemaVersion: 8 } },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-fast-fail',
          toolName: 'submit_planning_proposal',
          result: { details: result },
          isError: true,
        },
      ]) {
        child.stdout.write(`${JSON.stringify(event)}\n`);
      }
      setTimeout(() => {
        agentEndWritten = true;
        child.stdout.write(`${JSON.stringify({ type: 'agent_end', messages: [] })}\n`);
      }, 100);
    });
    child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      sessionDir: join(tmpdir(), `planner-supervisor-fast-fail-${process.pid}`),
      spawn: (() => child as never) as never,
    });

    const result = await supervisor.run('plan this', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-fast-fail', source: 'gateway' },
    } as never, 'kernel');

    expect(result.proposalResult).toMatchObject({
      status: 'transport_uncertain',
      message: 'kernel persistence failed',
    });
    expect(agentEndWritten).toBe(false);
  });

  it('attaches partial tool calls when a turn ends without a structured proposal result', async () => {
    const child = fakeProcess();
    child.stdin.on('data', chunk => {
      const request = JSON.parse(chunk.toString().trim()) as { id: string };
      for (const event of [
        { type: 'response', command: 'prompt', success: true, id: request.id },
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-read',
          toolName: 'read_planner_context',
          args: { section: 'task' },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-read',
          toolName: 'read_planner_context',
          result: { status: 'ok' },
          isError: false,
        },
        { type: 'agent_end', messages: [] },
      ]) {
        child.stdout.write(`${JSON.stringify(event)}\n`);
      }
    });
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      sessionDir: join(tmpdir(), `planner-supervisor-partial-${process.pid}`),
      spawn: (() => child as never) as never,
      shutdownGraceMs: 10,
    });

    const error = await supervisor.run('plan this', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-partial', source: 'gateway' },
    } as never, 'kernel').catch(value => value as Error);

    expect(error).toMatchObject({
      message: 'AnyFusion Planner RPC completed without a submit_planning_proposal tool result',
      toolCalls: [{
        sequence: 1,
        toolName: 'read_planner_context',
        status: 'completed',
      }],
    });
  });

  it('does not report a completed agent loop when the Planner model ends with an error', async () => {
    const child = fakeProcess();
    child.stdin.on('data', chunk => {
      const request = JSON.parse(chunk.toString().trim()) as { id: string };
      for (const event of [
        { type: 'response', command: 'prompt', success: true, id: request.id },
        { type: 'agent_start' },
        { type: 'turn_start' },
        { type: 'message_start', message: { role: 'assistant', content: [] } },
        {
          type: 'agent_end',
          messages: [{
            role: 'assistant',
            errorMessage: 'OpenAI API error (403): usage limit reached',
          }],
        },
      ]) {
        child.stdout.write(`${JSON.stringify(event)}\n`);
      }
    });
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      sessionDir: join(tmpdir(), `planner-supervisor-model-error-${process.pid}`),
      spawn: (() => child as never) as never,
      shutdownGraceMs: 10,
    });
    const progress: Array<Record<string, unknown>> = [];

    const error = await supervisor.run('plan this', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-model-error', source: 'gateway' },
    } as never, 'kernel', event => progress.push(event as unknown as Record<string, unknown>))
      .catch(value => value as Error);

    expect(error.message).toContain('AnyFusion Planner model failed');
    expect(progress.map(event => event.kind)).not.toContain('agent_completed');
  });

  it('uses one launch identity for RPC and interactive Planner modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'planner-supervisor-'));
    const launches: Array<{
      command: string;
      args: string[];
      options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown };
    }> = [];
    const spawn = vi.fn((command: string, args: string[], options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      stdio?: unknown;
    }) => {
      launches.push({ command, args, options });
      const child = fakeProcess();
      if (args[0] === '--version') {
        queueMicrotask(() => {
          child.stdout.write('planner 1.0.0\n');
          child.emit('close', 0, null);
        });
      } else if (Array.isArray(options.stdio)) {
        completeRpcTurn(child);
      }
      else queueMicrotask(() => child.emit('exit', 0, null));
      return child as never;
    });
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      plannerHome: join(root, 'planner-home'),
      sessionDir: join(root, 'planner-sessions'),
      envFile: '',
      socketPath: join(root, 'planner.sock'),
      schemaPath: '/release/planning-agent-plan-v8.schema.json',
      configurationRevision: 'revision-runtime',
      expectedModel: {
        provider: 'deepseek',
        modelId: 'deepseek-v4-pro',
      },
      spawn: spawn as never,
    });

    try {
      const rpc = await supervisor.runRpcTurn({
        sessionId: 'session-1',
        cwd: '/workspace/current-user',
        prompt: 'plan this',
        context: {
          timeoutMs: 1_000,
          request: { sessionId: 'session-1', source: 'gateway' },
          configuration: { revisionId: 'revision-runtime' },
        } as never,
        purpose: 'validation',
      });
      await supervisor.startInteractive({
        sessionId: 'session-1',
        cwd: '/workspace/current-user',
      });
      await expect(supervisor.probe()).resolves.toEqual({
        available: true,
        detail: 'planner 1.0.0',
      });

      expect(rpc.submittedPlan).toMatchObject({ id: 'plan-1' });
      expect(launches).toHaveLength(3);
      for (const launch of launches.slice(0, 2)) {
        expect(launch.command).toBe('/release/planner');
        expect(launch.options.cwd).toBe('/workspace/current-user');
        expect(launch.options.env).toMatchObject({
          ANYFUSION_PLANNER_HOME: join(root, 'planner-home'),
          ANYFUSION_PLANNER_SESSION_DIR: join(root, 'planner-sessions'),
          ANYFUSION_PLANNER_SESSION_ID: 'session-1',
          METACLAW_PLANNER_SESSION_ID: 'session-1',
          ANYFUSION_BRIDGE_SOCKET: join(root, 'planner.sock'),
          METACLAW_PLANNER_TUI_SOCKET: join(root, 'planner.sock'),
          ANYFUSION_PLANNER_SCHEMA_PATH: '/release/planning-agent-plan-v8.schema.json',
          METACLAW_CONFIGURATION_REVISION: 'revision-runtime',
        });
      }
      expect(launches[1]?.args).toEqual(expect.arrayContaining([
        '--gateway-socket',
        join(root, 'planner.sock'),
        '--conversation-id',
        'session-1',
      ]));
      expect(launches[1]?.args).not.toContain('--session');
      expect(launches[2]).toMatchObject({
        command: '/release/planner',
        args: ['--version'],
        options: {
          env: expect.objectContaining({
            ANYFUSION_PLANNER_HOME: join(root, 'planner-home'),
            ANYFUSION_PLANNER_SESSION_DIR: join(root, 'planner-sessions'),
            ANYFUSION_BRIDGE_SOCKET: join(root, 'planner.sock'),
            ANYFUSION_PLANNER_SCHEMA_PATH: '/release/planning-agent-plan-v8.schema.json',
          }),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('probes and stops controlled Planner processes', async () => {
    const probeChild = fakeProcess();
    const activeChild = fakeProcess();
    const spawn = vi.fn((_command: string, args: string[]) => {
      if (args[0] === '--version') {
        queueMicrotask(() => {
          probeChild.stdout.write('planner 1.0.0\n');
          probeChild.emit('close', 0, null);
        });
        return probeChild as never;
      }
      return activeChild as never;
    });
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      spawn: spawn as never,
    });

    await expect(supervisor.probe()).resolves.toEqual({
      available: true,
      detail: 'planner 1.0.0',
    });
    const running = supervisor.startInteractive({ sessionId: 'session-1', cwd: '/workspace' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    await supervisor.stop();

    expect(activeChild.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(running).resolves.toBeUndefined();
  });

  it('uses the current user cwd when an RPC caller does not override it', async () => {
    const child = fakeProcess();
    const spawn = vi.fn((_command: string, _args: string[], options: { cwd?: string }) => {
      completeRpcTurn(child);
      return child as never;
    });
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      sessionDir: join(tmpdir(), `planner-supervisor-session-${process.pid}`),
      spawn: spawn as never,
    });

    await supervisor.run('plan this', {
      timeoutMs: 1_000,
      request: { sessionId: 'session-current-cwd', source: 'gateway' },
    } as never, 'kernel');

    expect(spawn).toHaveBeenCalledWith(
      '/release/planner',
      expect.any(Array),
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });

  it('keeps the same-session RPC lock until a failed child actually exits', async () => {
    const children: FakeProcess[] = [];
    const spawn = vi.fn(() => {
      const child = fakeProcess();
      child.kill = vi.fn(() => true);
      if (children.length === 0) {
        let input = '';
        child.stdin.on('data', chunk => {
          input += chunk.toString();
          if (!input.includes('\n')) return;
          const request = JSON.parse(input.trim()) as { id: string };
          child.stdout.write(`${JSON.stringify({
            type: 'response',
            command: 'prompt',
            success: false,
            id: request.id,
            error: 'rejected',
          })}\n`);
        });
      } else {
        completeRpcTurn(child);
      }
      children.push(child);
      return child as never;
    });
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      sessionDir: join(tmpdir(), `planner-supervisor-lock-${process.pid}`),
      shutdownGraceMs: 1_000,
      spawn: spawn as never,
    });
    const context = {
      timeoutMs: 1_000,
      request: { sessionId: 'shared-session', source: 'gateway' },
    } as never;

    const first = supervisor.run('first', context, 'kernel');
    const second = supervisor.run('second', context, 'kernel');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM'));
    expect(spawn).toHaveBeenCalledTimes(1);

    children[0]?.emit('close', null, 'SIGTERM');
    await expect(first).rejects.toThrow('rejected');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    await expect(second).resolves.toMatchObject({ submittedPlan: { id: 'plan-1' } });
  });

  it('escalates shutdown to SIGKILL after the grace period', async () => {
    const child = fakeProcess();
    child.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
      if (signal === 'SIGKILL') {
        queueMicrotask(() => {
          child.emit('exit', null, signal);
          child.emit('close', null, signal);
        });
      }
      return true;
    });
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      shutdownGraceMs: 5,
      spawn: (() => child as never) as never,
    });

    const running = supervisor.startInteractive({ sessionId: 'session-stuck', cwd: '/workspace' });
    await vi.waitFor(() => expect(child.listenerCount('exit')).toBeGreaterThan(0));
    await supervisor.stop();

    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    await expect(running).resolves.toBeUndefined();
  });

  it('does not start queued or new RPC turns after the session is stopped', async () => {
    const child = fakeProcess();
    child.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
      queueMicrotask(() => {
        child.emit('exit', null, signal);
        child.emit('close', null, signal);
      });
      return true;
    });
    const spawn = vi.fn(() => child as never);
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      sessionDir: join(tmpdir(), `planner-supervisor-closed-${process.pid}`),
      spawn: spawn as never,
    });
    const context = {
      timeoutMs: 1_000,
      request: { sessionId: 'closed-session', source: 'gateway' },
    } as never;

    const first = supervisor.run('first', context, 'kernel');
    const queued = supervisor.run('queued', context, 'kernel');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    await supervisor.stopSession('closed-session');

    await expect(first).rejects.toThrow();
    await expect(queued).rejects.toThrow('session is closed');
    await expect(supervisor.run('new', context, 'kernel')).rejects.toThrow('session is closed');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('does not start queued or new RPC turns after global shutdown begins', async () => {
    const child = fakeProcess();
    const spawn = vi.fn(() => child as never);
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      sessionDir: join(tmpdir(), `planner-supervisor-stopping-${process.pid}`),
      spawn: spawn as never,
    });
    const context = {
      timeoutMs: 1_000,
      request: { sessionId: 'shutdown-session', source: 'gateway' },
    } as never;

    const first = supervisor.run('first', context, 'kernel');
    const queued = supervisor.run('queued', context, 'kernel');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    await supervisor.stop();

    await expect(first).rejects.toThrow();
    await expect(queued).rejects.toThrow('supervisor is stopping');
    await expect(supervisor.run('new', context, 'kernel')).rejects.toThrow('supervisor is stopping');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('rechecks session closure after asynchronous launch resolution before spawning', async () => {
    let releaseDirectory!: () => void;
    const directoryReady = new Promise<void>(resolve => { releaseDirectory = resolve; });
    const ensureSessionDir = vi.fn(() => directoryReady);
    const spawn = vi.fn();
    const supervisor = new PlannerProcessSupervisor({
      command: '/release/planner',
      sessionDir: '/planner/sessions',
      ensureSessionDir,
      spawn: spawn as never,
    });
    const context = {
      timeoutMs: 1_000,
      request: { sessionId: 'pre-spawn-session', source: 'gateway' },
    } as never;

    const running = supervisor.run('plan', context, 'kernel');
    await vi.waitFor(() => expect(ensureSessionDir).toHaveBeenCalledWith('/planner/sessions'));
    await supervisor.stopSession('pre-spawn-session');
    releaseDirectory();

    await expect(running).rejects.toThrow('session is closed');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['--no-session', '--session', '--session-id', '--session-dir', '--continue', '--resume'])(
    'rejects the interactive session selector %s',
    async selector => {
      const supervisor = new PlannerProcessSupervisor({
        command: '/release/planner',
        interactiveArgs: [selector],
        spawn: vi.fn() as never,
      });

      await expect(supervisor.startInteractive({
        sessionId: 'session-override',
        cwd: '/workspace',
      })).rejects.toThrow('may not override');
    },
  );
});
