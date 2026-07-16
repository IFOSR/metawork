import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ExecutorAdapter, ExecutorInput } from '../../src/executor/adapter.js';
import type { AgentClass, Config, ExecutorResult, Subtask, Task, WorkUnit } from '../../src/core/types.js';
import {
  createDefaultExecutorAdapterRegistry,
  ExecutionRuntime,
  ExecutorAdapterRegistry,
  ExecutorRegistry,
} from '../../src/execution/execution-runtime.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: { command: 'codex', timeout: 60_000, max_duration: 300 },
    orchestration: { reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5 },
    ui: { language: 'zh-CN', dashboard_on_start: false },
  };
}

function createExecutor(name: string, result: ExecutorResult | Promise<ExecutorResult>): ExecutorAdapter {
  return {
    name,
    execute: vi.fn().mockImplementation(async (_input: ExecutorInput) => result),
    isAvailable: vi.fn().mockResolvedValue(true),
    abort: vi.fn(),
  };
}

function createTask(): Task {
  return {
    id: 'task_runtime',
    title: 'runtime task',
    goal: 'execute runtime task',
    status: 'running',
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [],
    prioritySignals: {
      dueAt: null,
      isReady: true,
      progressRatio: 0,
      blocksOthers: false,
      idleHours: 0,
    },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: '2026-06-22T00:00:00Z',
    updatedAt: '2026-06-22T00:00:00Z',
  };
}

function createResult(output: string, success = true): ExecutorResult {
  return {
    success,
    output: success ? output : '',
    error: success ? undefined : output,
    exitCode: success ? 0 : 1,
    durationMs: 42,
  };
}

function createAgentClass(name = 'codex-cli'): AgentClass {
  return {
    name,
    kind: 'executor',
    domains: ['software'],
    capabilities: ['coding'],
    inputTypes: ['text'],
    outputTypes: ['markdown'],
    strengths: [],
    weaknesses: [],
    primaryUseCases: [],
    avoidUseCases: [],
    intentAffinity: {},
    riskLevel: 'medium',
    harness: 'cli',
    model: null,
    skills: [],
    mcpServers: [],
    plugins: [],
    runtimeCommand: null,
    runtimeArgs: [],
    runtimeCheckCommand: null,
    projectUrl: null,
  };
}

function createSubtask(): Subtask {
  return {
    id: 'subtask_runtime',
    taskId: 'task_runtime',
    title: 'Runtime subtask',
    goal: 'execute runtime subtask',
    status: 'running',
    dependsOn: [],
    requiredAgentClassKind: 'executor',
    agentClassHint: 'codex-cli',
    candidateAgentClasses: ['codex-cli'],
    expectedOutput: 'summary',
    acceptance: [],
    riskLevel: 'medium',
    result: '',
    error: null,
    createdAt: '2026-06-22T00:00:00Z',
    updatedAt: '2026-06-22T00:00:00Z',
  };
}

function createWorkUnit(agentClassName = 'codex-cli'): WorkUnit {
  return {
    id: 'executor-1',
    agentClassName,
    agentClassKind: 'executor',
    state: 'running',
    claimedTaskId: 'task_runtime',
    claimedSubtaskId: 'subtask_runtime',
    heartbeatAt: '2026-06-22T00:00:00Z',
    leaseExpiresAt: null,
    createdAt: '2026-06-22T00:00:00Z',
    updatedAt: '2026-06-22T00:00:00Z',
  };
}

function createExecutorInput(): Omit<ExecutorInput, 'onProgress'> {
  return {
    task: createTask(),
    preferences: [],
    userPrompt: 'execute task',
    conversationHistory: [],
  };
}

function createRuntime(options: {
  defaultExecutor?: ExecutorAdapter;
  defaultExecutorFactory?: () => ExecutorAdapter;
  executors?: Record<string, ExecutorAdapter>;
  db?: Database.Database;
} = {}): ExecutionRuntime {
  const defaultExecutor = options.defaultExecutor ?? createExecutor('codex-cli', createResult('default ok'));
  const registry = new ExecutorRegistry({
    db: options.db ?? createDb(),
    config: createConfig(),
    defaultExecutor,
    defaultExecutorFactory: options.defaultExecutorFactory,
    executorFactory: name => options.executors?.[name] ?? null,
  });
  return new ExecutionRuntime(registry, defaultExecutor);
}

describe('ExecutionRuntime', () => {
  it('creates an isolated default executor per run so aborting one task cannot stop another', async () => {
    let resolveFirst!: (result: ExecutorResult) => void;
    let resolveSecond!: (result: ExecutorResult) => void;
    const firstPending = new Promise<ExecutorResult>(done => { resolveFirst = done; });
    const secondPending = new Promise<ExecutorResult>(done => { resolveSecond = done; });
    const first = createExecutor('codex-cli', firstPending);
    const second = createExecutor('codex-cli', secondPending);
    const defaultExecutor = createExecutor('codex-cli', createResult('availability only'));
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const runtime = createRuntime({ defaultExecutor, defaultExecutorFactory: factory });

    const runFirst = runtime.run({
      taskId: 'task_first',
      executionId: 'exec_first',
      spec: {
        subtask: createSubtask(),
        workUnit: createWorkUnit('codex-cli'),
        agentClass: createAgentClass('codex-cli'),
        acceptance: [],
        expectedOutput: 'summary',
      },
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });
    const runSecond = runtime.run({
      taskId: 'task_second',
      executionId: 'exec_second',
      spec: {
        subtask: createSubtask(),
        workUnit: createWorkUnit('codex-cli'),
        agentClass: createAgentClass('codex-cli'),
        acceptance: [],
        expectedOutput: 'summary',
      },
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });
    await Promise.resolve();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(runtime.abortTask('task_first')).toBe(1);
    expect(first.abort).toHaveBeenCalledTimes(1);
    expect(second.abort).not.toHaveBeenCalled();
    expect(defaultExecutor.abort).not.toHaveBeenCalled();

    resolveFirst(createResult('first late result'));
    resolveSecond(createResult('second result'));
    await Promise.all([runFirst, runSecond]);
  });

  it('tracks and aborts the actual routed executor for a task, then clears the execution token', async () => {
    let resolve!: (result: ExecutorResult) => void;
    const pending = new Promise<ExecutorResult>(done => { resolve = done; });
    const routed = createExecutor('pi-agent', pending);
    const defaultExecutor = createExecutor('codex-cli', createResult('default should not run'));
    const runtime = createRuntime({ defaultExecutor, executors: { 'pi-agent': routed } });

    const run = runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_active',
      spec: {
        subtask: createSubtask(),
        workUnit: createWorkUnit('pi-agent'),
        agentClass: createAgentClass('pi-agent'),
        acceptance: [],
        expectedOutput: 'summary',
      },
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });
    await Promise.resolve();

    expect(runtime.abortTask('task_runtime')).toBe(1);
    expect(routed.abort).toHaveBeenCalledTimes(1);
    expect(defaultExecutor.abort).not.toHaveBeenCalled();

    resolve(createResult('late result'));
    await run;
    expect(runtime.abortTask('task_runtime')).toBe(0);
  });

  it('executes a claimed subtask on the claimed work unit agent class', async () => {
    const deepseek = createExecutor('deepseek-tui', createResult('deepseek ok'));
    const runtime = createRuntime({ executors: { 'deepseek-tui': deepseek } });
    const agentClass = createAgentClass('deepseek-tui');

    const result = await runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_runtime',
      spec: {
        subtask: createSubtask(),
        workUnit: createWorkUnit('deepseek-tui'),
        agentClass,
        acceptance: [],
        expectedOutput: 'summary',
      },
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });

    expect(result.executorName).toBe('deepseek-tui');
    expect(result.output).toBe('deepseek ok');
    expect(result.runtime.attemptedExecutors).toEqual(['deepseek-tui']);
    expect(result.runtime.fallbackExecutors).toEqual([]);
    expect(deepseek.execute).toHaveBeenCalledTimes(1);
  });

  it('does not perform runtime fallback when the claimed executor fails', async () => {
    const codex = createExecutor('codex-cli', createResult('codex should not run'));
    const pi = createExecutor('pi-agent', createResult('executor idle timeout', false));
    const runtime = createRuntime({
      defaultExecutor: codex,
      executors: { 'pi-agent': pi },
    });

    const result = await runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_runtime',
      spec: {
        subtask: createSubtask(),
        workUnit: createWorkUnit('pi-agent'),
        agentClass: createAgentClass('pi-agent'),
        acceptance: [],
        expectedOutput: 'summary',
      },
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });

    expect(result.status).toBe('failed');
    expect(result.executorName).toBe('pi-agent');
    expect(result.runtime.attemptedExecutors).toEqual(['pi-agent']);
    expect(result.runtime.fallbackExecutors).toEqual([]);
    expect(pi.execute).toHaveBeenCalledTimes(1);
    expect(codex.execute).not.toHaveBeenCalled();
  });

  it('resolves custom executor runtime agent classes through the registry', () => {
    const db = createDb();
    new AgentClassRepo(db).upsert({
      ...createAgentClass('research-bot'),
      domains: ['research'],
      capabilities: ['report_generation'],
      runtimeCommand: 'research-bot',
      runtimeArgs: ['run', '--prompt', '{prompt}'],
      runtimeCheckCommand: 'research-bot --version',
    });
    const defaultExecutor = createExecutor('codex-cli', createResult('default ok'));
    const registry = new ExecutorRegistry({
      db,
      config: createConfig(),
      defaultExecutor,
    });

    const executor = registry.resolve('research-bot');

    expect(executor?.name).toBe('research-bot');
    expect(executor?.constructor.name).toBe('CustomCliExecutorAdapter');
  });

  it('resolves registered adapter factories without editing runtime branching logic', () => {
    const db = createDb();
    const defaultExecutor = createExecutor('codex-cli', createResult('default ok'));
    const adapterRegistry = new ExecutorAdapterRegistry()
      .register('test-agent', config => createExecutor('test-agent', createResult(`timeout=${config.timeout}`)), ['test']);
    const registry = new ExecutorRegistry({
      db,
      config: createConfig(),
      defaultExecutor,
      adapterRegistry,
    });

    const executor = registry.resolve('test-agent');

    expect(executor?.name).toBe('test-agent');
  });

  it('derives canonical adapter names, aliases, and runtime commands from definitions', () => {
    let codexCommand = '';
    const registry = new ExecutorAdapterRegistry()
      .registerCanonical('codex-cli', (_config, command) => {
        codexCommand = command;
        return createExecutor('codex-cli', createResult('ok'));
      });

    expect(registry.createByCommand('codex', {
      timeout: 60,
      workspaceRoot: process.cwd(),
    })?.name).toBe('codex-cli');
    expect(codexCommand).toBe('codex');
  });

  it('fails closed on duplicate adapter names and aliases', () => {
    const registry = new ExecutorAdapterRegistry()
      .register('first', () => createExecutor('first', createResult('ok')), ['shared']);

    expect(() => registry.register(
      'second',
      () => createExecutor('second', createResult('ok')),
      ['shared'],
    )).toThrow('Duplicate Executor Adapter binding: shared');
    expect(() => registry.register(
      'first',
      () => createExecutor('first', createResult('ok')),
    )).toThrow('Duplicate Executor Adapter binding: first');
  });

  it('keeps non-canonical built-in adapters registered', () => {
    const registry = createDefaultExecutorAdapterRegistry();
    const config = { timeout: 60, workspaceRoot: process.cwd() };

    expect(registry.createByCommand('claude', config)?.name).toBe('claude-code');
    expect(registry.createByCommand('hermes', config)?.name).toBe('hermes-agent');
    expect(registry.createByCommand('deepseek', config)?.name).toBe('deepseek-tui');
    expect(registry.createByCommand('openclaw', config)?.name).toBe('openclaw');
  });
});
