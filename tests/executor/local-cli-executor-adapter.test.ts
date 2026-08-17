import { describe, expect, it, vi } from 'vitest';
import type { RuntimePrivateConfigurationBinding } from '../../src/configuration/types.js';
import { COMPLETION_MARKER_V3 } from '../../src/execution/completion-protocol.js';
import type { ExecutorInput } from '../../src/executor/adapter.js';
import type { HarnessDriver } from '../../src/executor/harness-driver.js';
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
    });
    expect(processRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-1',
      command: 'selected-driver-command',
      args: ['--execute'],
      cwd: '/workspace/attempt-1',
      environment: {
        DRIVER_HOME: 'materialized',
        DRIVER_LAUNCH: 'selected',
      },
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

function runtimeBinding(): RuntimePrivateConfigurationBinding {
  return {
    revisionId: 'revision-10',
    bindingFingerprint: 'binding-fingerprint',
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
        availability: 'unavailable',
        reason: 'unit test',
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
