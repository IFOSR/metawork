import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function completeRpcTurn(child: FakeProcess): void {
  let input = '';
  child.stdin.on('data', chunk => {
    input += chunk.toString();
    if (!input.includes('\n')) return;
    const request = JSON.parse(input.trim()) as { id: string };
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
  });
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
}

describe('PlannerProcessSupervisor', () => {
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
      expect(launches[1]?.args).toContain(join(root, 'planner-sessions', 'session-1.interactive.jsonl'));
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
