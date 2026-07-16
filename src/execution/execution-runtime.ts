// Resolves executor adapters and runs claimed subtask specs through the execution result normalization path.
import type Database from 'better-sqlite3';
import type { ExecutorAdapter, ExecutorInput, ExecutorProgressEvent } from '../executor/adapter.js';
import { ClaudeCodeAdapter } from '../executor/claude-code.js';
import { CodexCliAdapter } from '../executor/codex-cli.js';
import { CustomCliExecutorAdapter } from '../executor/custom-cli.js';
import { DeepSeekTuiAdapter } from '../executor/deepseek-tui.js';
import { HermesAgentAdapter } from '../executor/hermes-agent.js';
import { OpenClawAdapter } from '../executor/openclaw.js';
import { PiAgentAdapter } from '../executor/pi-agent.js';
import {
  getBuiltinExecutorDefinition,
  getBuiltinExecutorDefinitions,
  type BuiltinExecutorName,
} from '../executor/builtin-executor-catalog.js';
import { AgentClassRepo } from '../storage/agent-class-repo.js';
import type { AgentClass, Config, ExecutionContextBundleV2, ExecutorResult, ResolvedPreference, Subtask, WorkUnit } from '../core/types.js';
import type { SubtaskResult } from './execution-aggregator.js';
import type { ActiveExecutionControl } from './active-execution-control.js';

// Shared normalized result of running a task's work graph. Previously exported by
// the retired core/execution-planning-service module; kept here on the live path.
export interface ExecutionResult {
  taskId: string;
  executionId: string;
  status: 'success' | 'failed' | 'blocked' | 'cancelled';
  executorName: string;
  output: string;
  error: string | null;
  artifacts: string[];
  subtaskResults: SubtaskResult[];
  durationMs: number;
  userPrompt: string;
  preferences: ResolvedPreference[];
  context: ExecutionContextBundleV2;
  recovery: {
    recoverable: boolean;
    blockReason: string | null;
  };
  runtime: {
    attemptedExecutors: string[];
    fallbackExecutors: string[];
    fallbackReason: string | null;
    fallbackLines: string[];
  };
}

export interface ExecutorRegistryDeps {
  db: Database.Database;
  config: Config;
  defaultExecutor: ExecutorAdapter;
  defaultExecutorFactory?: () => ExecutorAdapter;
  executorFactory?: (name: string) => ExecutorAdapter | null;
  adapterRegistry?: ExecutorAdapterRegistry;
}

interface AdapterFactoryConfig {
  timeout: number;
  maxDuration?: number;
  workspaceRoot: string;
}

export type AdapterFactory = (config: AdapterFactoryConfig) => ExecutorAdapter;
export type CanonicalAdapterFactory = (
  config: AdapterFactoryConfig,
  command: string,
) => ExecutorAdapter;

export interface ExecutorRegistrationInspection {
  configured: boolean;
  bindingSource: 'default' | 'injected' | 'built-in' | 'custom-cli' | 'unbound';
  adapterName: string | null;
}

function withLongResearchTimeoutDefaults<T extends AdapterFactoryConfig>(config: T): T {
  return {
    ...config,
    timeout: Math.max(config.timeout, 900),
    maxDuration: Math.max(config.maxDuration ?? 0, 7200),
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

/** Registers built-in executor adapter factories and maps runtime command aliases to adapter names. */
export class ExecutorAdapterRegistry {
  private readonly factories = new Map<string, AdapterFactory>();
  private readonly commandAliases = new Map<string, string>();
  private readonly canonicalRegistrations = new Set<BuiltinExecutorName>();

  register(name: string, factory: AdapterFactory, commandAliases: string[] = []): this {
    const bindingKeys = [name, ...commandAliases];
    const seen = new Set<string>();
    for (const bindingKey of bindingKeys) {
      if (seen.has(bindingKey) || this.commandAliases.has(bindingKey)) {
        throw new Error(`Duplicate Executor Adapter binding: ${bindingKey}`);
      }
      seen.add(bindingKey);
    }
    if (this.factories.has(name)) {
      throw new Error(`Duplicate Executor Adapter name: ${name}`);
    }
    this.factories.set(name, factory);
    this.commandAliases.set(name, name);
    for (const alias of commandAliases) {
      this.commandAliases.set(alias, name);
    }
    return this;
  }

  registerCanonical(name: BuiltinExecutorName, factory: CanonicalAdapterFactory): this {
    const definition = getBuiltinExecutorDefinition(name);
    if (!definition) {
      throw new Error(`Missing canonical Executor definition: ${name}`);
    }
    const command = definition.adapterBinding.commandAliases[0];
    if (!command) {
      throw new Error(`Canonical Executor ${name} has no runtime command alias`);
    }
    this.register(
      definition.adapterBinding.adapterName,
      config => factory(config, command),
      [...definition.adapterBinding.commandAliases],
    );
    this.canonicalRegistrations.add(name);
    return this;
  }

  assertCanonicalCoverage(): this {
    const missing = getBuiltinExecutorDefinitions()
      .map(definition => definition.name)
      .filter(name => !this.canonicalRegistrations.has(name))
      .sort((left, right) => left.localeCompare(right));
    if (missing.length > 0) {
      throw new Error(`Missing canonical Executor Adapter registrations: ${missing.join(', ')}`);
    }
    return this;
  }

  create(name: string, config: AdapterFactoryConfig): ExecutorAdapter | null {
    const factory = this.factories.get(name);
    return factory ? factory(config) : null;
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  createByCommand(command: string, config: AdapterFactoryConfig): ExecutorAdapter | null {
    const name = this.commandAliases.get(command);
    return name ? this.create(name, config) : null;
  }
}

export function createDefaultExecutorAdapterRegistry(): ExecutorAdapterRegistry {
  return new ExecutorAdapterRegistry()
    .registerCanonical('codex-cli', (config, command) => new CodexCliAdapter({ ...config, command }))
    .register('claude-code', config => new ClaudeCodeAdapter({ ...config, command: 'claude' }), ['claude'])
    .register('hermes-agent', config => new HermesAgentAdapter(withLongResearchTimeoutDefaults({ ...config, command: 'hermes' })), ['hermes'])
    .registerCanonical('pi-agent', (config, command) => new PiAgentAdapter(withLongResearchTimeoutDefaults({ ...config, command })))
    .register('deepseek-tui', config => new DeepSeekTuiAdapter({ ...config, command: 'deepseek-tui' }), ['deepseek'])
    .register('openclaw', config => new OpenClawAdapter({ ...config, command: 'openclaw' }))
    .assertCanonicalCoverage();
}

/** Resolves executor names from injected defaults, registered adapters, or custom AgentClass runtime commands. */
export class ExecutorRegistry {
  private readonly adapterRegistry: ExecutorAdapterRegistry;

  constructor(private readonly deps: ExecutorRegistryDeps) {
    this.adapterRegistry = deps.adapterRegistry ?? createDefaultExecutorAdapterRegistry();
  }

  resolve(name: string): ExecutorAdapter | null {
    if (name === this.deps.defaultExecutor.name) {
      return this.deps.defaultExecutorFactory?.() ?? this.deps.defaultExecutor;
    }

    const injected = this.deps.executorFactory?.(name);
    if (injected) {
      return injected;
    }

    const registered = this.adapterRegistry.create(name, {
      timeout: this.deps.config.executor.timeout,
      maxDuration: this.deps.config.executor.max_duration,
      workspaceRoot: process.cwd(),
    });
    if (registered) {
      return registered;
    }

    const customAgentClass = new AgentClassRepo(this.deps.db).findByName(name);
    if (!customAgentClass?.runtimeCommand) {
      return null;
    }

    return new CustomCliExecutorAdapter({
      name,
      command: customAgentClass.runtimeCommand,
      args: customAgentClass.runtimeArgs ?? [],
      checkCommand: customAgentClass.runtimeCheckCommand,
      timeout: this.deps.config.executor.timeout,
      maxDuration: this.deps.config.executor.max_duration,
      workspaceRoot: process.cwd(),
    });
  }

  resolveRequired(name: string): ExecutorAdapter {
    return this.resolve(name) ?? this.deps.defaultExecutor;
  }

  inspect(name: string): ExecutorRegistrationInspection {
    if (name === this.deps.defaultExecutor.name) {
      return { configured: true, bindingSource: 'default', adapterName: name };
    }

    const injected = this.deps.executorFactory?.(name);
    if (injected) {
      return { configured: true, bindingSource: 'injected', adapterName: injected.name };
    }

    if (this.adapterRegistry.has(name)) {
      return { configured: true, bindingSource: 'built-in', adapterName: name };
    }

    const customAgentClass = new AgentClassRepo(this.deps.db).findByName(name);
    if (customAgentClass?.runtimeCommand) {
      return { configured: true, bindingSource: 'custom-cli', adapterName: name };
    }

    return { configured: false, bindingSource: 'unbound', adapterName: null };
  }

  async isAvailable(name: string): Promise<boolean> {
    const adapter = this.resolve(name);
    if (!adapter) {
      return false;
    }
    const available = await adapter.isAvailable();
    return available !== false;
  }
}

export function createDefaultExecutor(config: {
  command: string;
  timeout: number;
  maxDuration?: number;
  workspaceRoot?: string;
}): ExecutorAdapter {
  const workspaceRoot = config.workspaceRoot ?? process.cwd();
  const adapterConfig = {
    timeout: config.timeout,
    maxDuration: config.maxDuration,
    workspaceRoot,
  };
  const registry = createDefaultExecutorAdapterRegistry();
  return registry.createByCommand(config.command, adapterConfig)
    ?? registry.create('claude-code', adapterConfig)!;
}

export interface ExecutionRuntimeRunInput {
  taskId: string;
  executionId: string;
  spec: SubtaskExecutionSpec;
  executorInput: Omit<ExecutorInput, 'onProgress'>;
  onProgress: (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void;
}

export interface SubtaskExecutionSpec {
  subtask: Subtask;
  workUnit: WorkUnit;
  agentClass: AgentClass;
  acceptance: string[];
  expectedOutput: Subtask['expectedOutput'];
}

/** Runs a claimed subtask with its selected executor and converts adapter output into the shared ExecutionResult shape. */
export class ExecutionRuntime implements ActiveExecutionControl {
  private readonly activeByTask = new Map<string, Map<string, { workUnitId: string; executor: ExecutorAdapter }>>();
  private executionTokenSequence = 0;

  constructor(
    private readonly registry: ExecutorRegistry,
    _defaultExecutor: ExecutorAdapter,
  ) {}

  isExecutorAvailable(name: string): Promise<boolean> {
    return this.registry.isAvailable(name);
  }

  inspectExecutorRegistration(name: string): ExecutorRegistrationInspection {
    return this.registry.inspect(name);
  }

  async run(input: ExecutionRuntimeRunInput): Promise<ExecutionResult> {
    const executor = this.registry.resolveRequired(input.spec.agentClass.name);
    const executionToken = `${input.executionId}:${input.spec.workUnit.id}:${this.executionTokenSequence += 1}`;
    this.registerActive(input.taskId, executionToken, input.spec.workUnit.id, executor);
    try {
      const result = await this.executeOnce(
        executor,
        input.executorInput,
        input.onProgress,
      );
      return this.toExecutionResult({
        input,
        executor,
        result,
        subtaskResults: [],
        runtime: {
          attemptedExecutors: [executor.name],
          fallbackExecutors: [],
          fallbackReason: null,
          fallbackLines: [],
        },
      });
    } finally {
      this.clearActive(input.taskId, executionToken);
    }
  }

  abortTask(taskId: string): number {
    const active = this.activeByTask.get(taskId);
    if (!active || active.size === 0) {
      return 0;
    }

    const executors = Array.from(new Set(Array.from(active.values()).map(entry => entry.executor)));
    for (const executor of executors) {
      executor.abort();
    }
    return active.size;
  }

  private registerActive(
    taskId: string,
    executionToken: string,
    workUnitId: string,
    executor: ExecutorAdapter,
  ): void {
    const active = this.activeByTask.get(taskId) ?? new Map();
    active.set(executionToken, { workUnitId, executor });
    this.activeByTask.set(taskId, active);
  }

  private clearActive(taskId: string, executionToken: string): void {
    const active = this.activeByTask.get(taskId);
    if (!active) return;
    active.delete(executionToken);
    if (active.size === 0) {
      this.activeByTask.delete(taskId);
    }
  }

  private toExecutionResult(input: {
    input: ExecutionRuntimeRunInput;
    executor: ExecutorAdapter;
    result: ExecutorResult;
    subtaskResults: SubtaskResult[];
    runtime: ExecutionResult['runtime'];
  }): ExecutionResult {
    return {
      taskId: input.input.taskId,
      executionId: input.input.executionId,
      status: input.result.interrupted
        ? 'cancelled'
        : input.result.success ? 'success' : 'failed',
      executorName: input.executor.name,
      output: input.result.output,
      error: input.result.error ?? null,
      artifacts: input.subtaskResults.flatMap(result => result.artifacts),
      subtaskResults: input.subtaskResults,
      durationMs: input.result.durationMs,
      userPrompt: input.input.executorInput.userPrompt,
      preferences: input.input.executorInput.executionContextBundle?.memoryContext.resolvedPreferences ?? [],
      context: input.input.executorInput.executionContextBundle!,
      recovery: {
        recoverable: Boolean(input.result.error),
        blockReason: input.result.error ?? null,
      },
      runtime: input.runtime,
    };
  }

  private async executeOnce(
    executor: ExecutorAdapter,
    input: Omit<ExecutorInput, 'onProgress'>,
    onProgress: (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void,
  ): Promise<ExecutorResult> {
    let progressCallbackError: Error | null = null;
    try {
      return await executor.execute({
        ...input,
        onProgress: event => {
          try {
            onProgress(event, executor);
          } catch (error) {
            progressCallbackError = error as Error;
            throw error;
          }
        },
      });
    } catch (error) {
      if (progressCallbackError === error) {
        throw error;
      }
      return {
        success: false,
        output: '',
        error: (error as Error).message,
        exitCode: 1,
        durationMs: 0,
      };
    }
  }
}
