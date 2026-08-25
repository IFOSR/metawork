import { describe, expect, it, vi } from 'vitest';
import type { RuntimePrivateConfigurationBinding } from '../../src/configuration/types.js';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import { COMPLETION_MARKER_V3 } from '../../src/execution/completion-protocol.js';
import type { ExecutorInput } from '../../src/executor/adapter.js';
import type {
  HarnessDriver,
  HarnessProgressLineInput,
  HarnessResultInput,
} from '../../src/executor/harness-driver.js';
import {
  LocalCliExecutorAdapter,
  SpawnLocalCliChildProcessRunner,
  type LocalCliChildProcessRunner,
} from '../../src/executor/local-cli-executor-adapter.js';

describe('LocalCliExecutorAdapter', () => {
  it('runs the selected Harness driver with an isolated attempt Home', async () => {
    const driver = harnessDriver('pi-cli');
    const processRunner: LocalCliChildProcessRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: 'raw output\n',
        stderr: '',
      })),
      abort: vi.fn(),
    };
    const adapter = new LocalCliExecutorAdapter({
      agentClassId: 'quality-beta',
      driver,
      runtimeBinding: runtimeBinding(),
      authorizedBinding: authorizedBinding(),
      modelId: 'deepseek-v4-pro',
      attemptsRoot: '/runtime/attempts',
      processRunner,
    });

    const result = await adapter.execute(executorInput('attempt-1'));

    expect(driver.materializeHome).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      revisionId: 'revision-10',
      agentClassId: 'quality-beta',
      bindingFingerprint: 'binding-fingerprint',
      attemptsRoot: '/runtime/attempts',
      environment: {},
    });
    expect(driver.buildLaunch).toHaveBeenCalledWith({
      prompt: expect.stringContaining('Operative goal: Implement the selected slice'),
      cwd: '/workspace/attempt-1',
      runtimeHomePath: '/runtime/attempts/attempt-1/home',
      providerRef: 'deepseek',
      modelId: 'deepseek-v4-pro',
    });
    expect(processRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-1',
      command: 'selected-driver-command',
      args: ['--execute'],
      cwd: '/workspace/attempt-1',
      environment: expect.objectContaining({
        DRIVER_HOME: 'materialized',
        DRIVER_LAUNCH: 'selected',
        METACLAW_EVIDENCE_MCP_URL: 'http://127.0.0.1:31000/mcp',
        METACLAW_EVIDENCE_JSON_URL: 'http://127.0.0.1:31000/evidence',
        METACLAW_EVIDENCE_TOKEN: 'evidence-token',
      }),
    }));
    expect(driver.parseResult).toHaveBeenCalledWith({
      exitCode: 0,
      stdout: 'raw output\n',
      stderr: '',
    });
    expect(result).toMatchObject({
      success: true,
      output: 'normalized output',
      exitCode: 0,
    });
  });

  it('fails closed before materializing a Home when attempt execution input is missing', async () => {
    const driver = harnessDriver('codex-cli');
    const processRunner: LocalCliChildProcessRunner = {
      run: vi.fn(),
      abort: vi.fn(),
    };
    const adapter = new LocalCliExecutorAdapter({
      agentClassId: 'implementation-alpha',
      driver,
      runtimeBinding: runtimeBinding(),
      authorizedBinding: authorizedBinding(),
      modelId: 'deepseek-v4-pro',
      attemptsRoot: '/runtime/attempts',
      processRunner,
    });
    const input = executorInput('attempt-1');
    delete input.executionBinding;

    const result = await adapter.execute(input);

    expect(result).toMatchObject({
      success: false,
      output: '',
      error: 'execution binding is required',
      failure: {
        kind: 'configuration',
        scope: 'agent_class',
        code: 'execution_binding_missing',
      },
    });
    expect(driver.materializeHome).not.toHaveBeenCalled();
    expect(processRunner.run).not.toHaveBeenCalled();
  });

  it('normalizes child-process failures through the selected driver and delegates abort', async () => {
    const driver = harnessDriver('custom-driver', {
      success: false,
      output: '',
      error: 'normalized failure',
    });
    const processRunner: LocalCliChildProcessRunner = {
      run: vi.fn(async () => ({
        exitCode: 23,
        stdout: 'partial',
        stderr: 'raw failure',
      })),
      abort: vi.fn(),
    };
    const adapter = new LocalCliExecutorAdapter({
      agentClassId: 'arbitrary-agent-class',
      driver,
      runtimeBinding: runtimeBinding(),
      authorizedBinding: authorizedBinding(),
      modelId: 'deepseek-v4-pro',
      attemptsRoot: '/runtime/attempts',
      processRunner,
    });

    const result = await adapter.execute(executorInput('attempt-23'));
    adapter.abort('attempt-23');

    expect(driver.parseResult).toHaveBeenCalledWith({
      exitCode: 23,
      stdout: 'partial',
      stderr: 'raw failure',
    });
    expect(result).toMatchObject({
      success: false,
      output: '',
      error: 'normalized failure',
      exitCode: 23,
    });
    expect(processRunner.abort).toHaveBeenCalledWith('attempt-23');
  });

  it('forwards only driver-parsed structured progress from child output', async () => {
    const driver = harnessDriver('pi-cli');
    driver.parseProgressLine = vi.fn(input => input.line.includes('tool_execution_start')
      ? { kind: 'skill', text: 'Executor started tool: web_search' }
      : null);
    const processRunner: LocalCliChildProcessRunner = {
      run: vi.fn(async input => {
        input.onLine?.('{"type":"message_update","secret":"hidden"}', 'stdout');
        input.onLine?.('{"type":"tool_execution_start"}', 'stdout');
        return { exitCode: 0, stdout: 'raw output\n', stderr: '' };
      }),
      abort: vi.fn(),
    };
    const progress = vi.fn();
    const adapter = new LocalCliExecutorAdapter({
      agentClassId: 'quality-beta',
      driver,
      runtimeBinding: runtimeBinding(),
      authorizedBinding: authorizedBinding(),
      modelId: 'deepseek-v4-pro',
      attemptsRoot: '/runtime/attempts',
      processRunner,
    });
    const input = executorInput('attempt-progress');
    input.onProgress = progress;

    await adapter.execute(input);

    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({
      kind: 'skill',
      text: 'Executor started tool: web_search',
    });
  });

  it('returns a separately streamed final answer when bounded stdout no longer contains it', async () => {
    const driver = harnessDriver('pi-cli') as HarnessDriver & {
      parseResultLine?(input: HarnessProgressLineInput): string | null;
    };
    driver.parseResultLine = vi.fn(input => (
      input.line.includes('"message_end"') ? 'Complete final answer' : null
    ));
    driver.parseResult = vi.fn((input: HarnessResultInput & { streamedOutput?: string | null }) => ({
      success: true,
      output: input.streamedOutput ?? 'truncated diagnostic tail',
    }));
    const processRunner: LocalCliChildProcessRunner = {
      run: vi.fn(async input => {
        input.onLine?.('{"type":"message_end","message":{"role":"assistant"}}', 'stdout');
        return { exitCode: 0, stdout: 'truncated diagnostic tail', stderr: '' };
      }),
      abort: vi.fn(),
    };
    const adapter = new LocalCliExecutorAdapter({
      agentClassId: 'quality-beta',
      driver,
      runtimeBinding: runtimeBinding(),
      authorizedBinding: authorizedBinding(),
      modelId: 'deepseek-v4-pro',
      attemptsRoot: '/runtime/attempts',
      processRunner,
    });

    const result = await adapter.execute(executorInput('attempt-streamed-final'));

    expect(result).toMatchObject({
      success: true,
      output: 'Complete final answer',
    });
  });

  it('passes the configured idle watchdog to the local process runner', async () => {
    const driver = harnessDriver('codex-cli');
    const processRunner: LocalCliChildProcessRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: 'raw output\n',
        stderr: '',
      })),
      abort: vi.fn(),
    };
    const adapter = new LocalCliExecutorAdapter({
      agentClassId: 'implementation-alpha',
      driver,
      runtimeBinding: runtimeBinding(),
      authorizedBinding: authorizedBinding(),
      modelId: 'deepseek-v4-pro',
      attemptsRoot: '/runtime/attempts',
      idleTimeoutMs: 123_000,
      processRunner,
    });

    await adapter.execute(executorInput('attempt-watchdog'));

    expect(processRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-watchdog',
      idleTimeoutMs: 123_000,
    }));
  });

  it('does not inherit host Agent homes into a local CLI process', async () => {
    const spawnProcess = vi.fn((_command, _args, options) => {
      expect(options.env).not.toHaveProperty('HOME');
      expect(options.env).not.toHaveProperty('CODEX_HOME');
      expect(options.env).not.toHaveProperty('PI_CODING_AGENT_DIR');
      expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(options.env).toMatchObject({
        PATH: '/usr/bin',
        DRIVER_HOME: '/runtime/attempts/attempt-1/home',
      });
      return completedChildProcess();
    });
    const runner = new SpawnLocalCliChildProcessRunner({
      spawnProcess,
      hostEnvironment: {
        PATH: '/usr/bin',
        HOME: '/Users/host',
        CODEX_HOME: '/Users/host/.codex',
        PI_CODING_AGENT_DIR: '/Users/host/.pi/agent',
        OPENAI_API_KEY: 'host-secret',
      },
    });

    await runner.run({
      attemptId: 'attempt-1',
      command: 'selected-driver-command',
      args: [],
      cwd: '/workspace/attempt-1',
      environment: {
        DRIVER_HOME: '/runtime/attempts/attempt-1/home',
      },
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('retains final stdout events when a JSON stream exceeds the capture limit', async () => {
    const finalEvent = `${JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Final answer' }],
      },
    })}\n`;
    const spawnProcess = vi.fn(() => streamingChildProcess([
      'x'.repeat(16 * 1024 * 1024),
      finalEvent,
    ]));
    const runner = new SpawnLocalCliChildProcessRunner({ spawnProcess });

    const result = await runner.run({
      attemptId: 'attempt-large-json-stream',
      command: 'pi',
      args: [],
      cwd: '/workspace/attempt-large-json-stream',
      environment: {},
    });

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(result.stdout.endsWith(finalEvent)).toBe(true);
  });

  it('streams the complete raw child output independently from the bounded diagnostic tail', async () => {
    const prefix = 'x'.repeat(16 * 1024 * 1024);
    const finalEvent = '{"type":"message_end","message":{"role":"assistant"}}\n';
    const spawnProcess = vi.fn(() => streamingChildProcess([prefix, finalEvent]));
    const runner = new SpawnLocalCliChildProcessRunner({ spawnProcess });
    const rawChunks: string[] = [];

    const result = await runner.run({
      attemptId: 'attempt-complete-raw-stream',
      command: 'pi',
      args: [],
      cwd: '/workspace/attempt-complete-raw-stream',
      environment: {},
      onRawChunk: chunk => rawChunks.push(Buffer.from(chunk).toString('utf8')),
    });

    expect(rawChunks.join('')).toBe(`${prefix}${finalEvent}`);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it('terminates a local CLI process after the configured idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const child = controllableChildProcess();
      const signalProcess = vi.fn((_pid: number, signal: NodeJS.Signals) => {
        if (signal === 'SIGTERM') queueMicrotask(() => child.emitExit(null));
      });
      const runner = new SpawnLocalCliChildProcessRunner({ spawnProcess: () => child, signalProcess });

      const resultPromise = runner.run({
        attemptId: 'attempt-idle-timeout',
        command: 'codex',
        args: [],
        cwd: '/workspace/attempt-idle-timeout',
        environment: {},
        idleTimeoutMs: 300,
      });
      await vi.advanceTimersByTimeAsync(300);

      await expect(resultPromise).resolves.toMatchObject({
        exitCode: null,
        stderr: expect.stringContaining('executor idle timeout'),
      });
      expect(signalProcess).toHaveBeenCalledWith(-123, 'SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews the idle timeout when stdout or stderr remains active', async () => {
    vi.useFakeTimers();
    try {
      const child = controllableChildProcess();
      const signalProcess = vi.fn((_pid: number, signal: NodeJS.Signals) => {
        if (signal === 'SIGTERM') queueMicrotask(() => child.emitExit(null));
      });
      const runner = new SpawnLocalCliChildProcessRunner({ spawnProcess: () => child, signalProcess });

      const resultPromise = runner.run({
        attemptId: 'attempt-active-output',
        command: 'codex',
        args: [],
        cwd: '/workspace/attempt-active-output',
        environment: {},
        idleTimeoutMs: 300,
      });
      await vi.advanceTimersByTimeAsync(250);
      child.emitStdout('still active\n');
      await vi.advanceTimersByTimeAsync(250);
      expect(signalProcess).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(50);
      await resultPromise;
      expect(signalProcess).toHaveBeenCalledWith(-123, 'SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });
});

function completedChildProcess() {
  const listeners = new Map<string, (...args: any[]) => void>();
  const stream = { on: vi.fn() };
  const child = {
    pid: 123,
    stdout: stream,
    stderr: stream,
    once: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, listener);
      if (event === 'exit') queueMicrotask(() => listener(0));
      return child;
    }),
    kill: vi.fn(),
  };
  return child;
}

function streamingChildProcess(stdoutChunks: string[]) {
  let stdoutListener: ((chunk: string) => void) | null = null;
  const child = {
    pid: 123,
    stdout: {
      on: vi.fn((event: string, listener: (chunk: string) => void) => {
        if (event === 'data') stdoutListener = listener;
      }),
    },
    stderr: { on: vi.fn() },
    once: vi.fn((event: string, listener: (...args: any[]) => void) => {
      if (event === 'exit') {
        queueMicrotask(() => {
          for (const chunk of stdoutChunks) stdoutListener?.(chunk);
          listener(0);
        });
      }
      return child;
    }),
    kill: vi.fn(),
  };
  return child;
}

function controllableChildProcess() {
  let stdoutListener: ((chunk: string) => void) | null = null;
  let exitListener: ((code: number | null) => void) | null = null;
  const child = {
    pid: 123,
    stdout: {
      on: vi.fn((event: string, listener: (chunk: string) => void) => {
        if (event === 'data') stdoutListener = listener;
      }),
    },
    stderr: { on: vi.fn() },
    once: vi.fn((event: string, listener: (...args: any[]) => void) => {
      if (event === 'exit') exitListener = listener;
      return child;
    }),
    kill: vi.fn(),
    emitStdout(chunk: string) {
      stdoutListener?.(chunk);
    },
    emitExit(code: number | null) {
      exitListener?.(code);
    },
  };
  return child;
}

function runtimeBinding(): RuntimePrivateConfigurationBinding {
  return {
    revisionId: 'revision-10',
    bindingFingerprint: 'binding-fingerprint',
  };
}

function authorizedBinding(): AuthorizedExecutorBinding {
  return {
    agentClassRef: 'quality-beta',
    harnessRef: 'pi-cli',
    providerRef: 'deepseek',
    modelRef: 'deepseek-deepseek-v4-pro',
    permissionProfileRef: 'public-web-research',
    configurationRevision: 'revision-10',
  };
}

function harnessDriver(
  id: string,
  parsedResult: ReturnType<HarnessDriver['parseResult']> = {
    success: true,
    output: 'normalized output',
  },
): HarnessDriver {
  return {
    id,
    probe: vi.fn(async () => ({ available: true })),
    materializeHome: vi.fn(async input => ({
      homePath: `${input.attemptsRoot}/${input.attemptId}/home`,
      environment: { DRIVER_HOME: 'materialized' },
    })),
    buildLaunch: vi.fn(input => ({
      command: 'selected-driver-command',
      args: ['--execute'],
      cwd: input.cwd,
      environment: { DRIVER_LAUNCH: 'selected' },
    })),
    parseResult: vi.fn(() => parsedResult),
  };
}

function executorInput(attemptId: string): ExecutorInput {
  const workspacePath = `/workspace/${attemptId}`;
  return {
    context: {
      taskBackground: {
        id: 'task-1',
        title: 'Server upgrade',
        goal: 'Complete Task 10',
        instruction: 'background_only',
      },
      currentSubtask: {
        id: 'subtask-1',
        title: 'Local CLI adapter',
        goal: 'Implement the selected slice',
        deliveryKind: 'edit',
        acceptance: [],
      },
      incomingHandoffs: [],
      outgoingHandoffRequirements: [],
      selectedEvidence: [],
      outOfScopeSiblings: [],
      workspaceContext: {
        allowFilesystem: true,
        workingDirectory: workspacePath,
        targetPaths: [workspacePath],
      },
      identity: {
        executionId: 'execution-1',
        taskId: 'task-1',
        subtaskId: 'subtask-1',
        attemptId,
        workUnitId: 'work-unit-1',
      },
      completionContract: {
        marker: COMPLETION_MARKER_V3,
        schemaVersion: 3,
      },
      evidenceTools: {
        availability: 'available',
        reason: 'unit test',
        binding: {
          mcpUrl: 'http://127.0.0.1:31000/mcp',
          jsonUrl: 'http://127.0.0.1:31000/evidence',
          bearerToken: 'evidence-token',
        },
      },
    },
    executionBinding: {
      attemptId,
      taskId: 'task-1',
      generationId: 'generation-1',
      subtaskId: 'subtask-1',
      workUnitId: 'work-unit-1',
      leaseToken: 'lease-1',
      idempotencyKey: 'dispatch-1',
      workspacePath,
      workspaceId: 'workspace-1',
      sourcePath: '/source',
      inputsPath: '/inputs',
      handoffsPath: '/handoffs',
      gitMetadataPath: null,
      controlNetwork: 'metaclaw-control',
      capabilityBinding: null,
    },
  };
}
