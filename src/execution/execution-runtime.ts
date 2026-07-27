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
import type { AgentClass, Config, ExecutorResult, ResolvedPreference, Subtask, WorkUnit } from '../core/types.js';
import type { SubtaskExecutionContext } from './subtask-execution-context.js';
import type { SubtaskResult } from './execution-aggregator.js';
import type { ActiveExecutionControl } from './active-execution-control.js';
import type { WorkGraphAcceptanceCriterion } from '../work-graph/index.js';
import { kernelFailure, type KernelFailure } from '../core/kernel-failure.js';
import type { AgentClassLookupPort } from '../executor/agent-class-lookup-port.js';
import type { AttemptSandboxPort } from './attempt-sandbox.js';
import { SandboxedExecutorAdapter } from '../executor/sandboxed-executor-adapter.js';
import type { AttemptSandboxRepositoryPort } from './repositories.js';

// Shared normalized result of running a task's work graph. Previously exported by
// the retired core/execution-planning-service module; kept here on the live path.
// Recovery strategy is not represented here: the Adapter emits a structured
// KernelFailure and ControlKernel alone decides retry, fallback, replan or block.
export interface ExecutionResult {
  taskId: string;
  executionId: string;
  status: 'success' | 'failed' | 'blocked' | 'cancelled';
  executorName: string;
  output: string;
  error: string | null;
  failure: KernelFailure | null;
  artifacts: string[];
  subtaskResults: SubtaskResult[];
  durationMs: number;
  userPrompt: string;
  preferences: ResolvedPreference[];
  context: SubtaskExecutionContext;
}

export interface ExecutorRegistryDeps {
  /** @deprecated Host adapters are retained only for injected unit-test seams. */
  db?: Database.Database;
  config: Config;
  defaultExecutor: ExecutorAdapter;
  defaultExecutorFactory?: () => ExecutorAdapter;
  executorFactory?: (name: string) => ExecutorAdapter | null;
  adapterRegistry?: ExecutorAdapterRegistry;
  agentClassLookup?: AgentClassLookupPort;
  attemptSandbox?: AttemptSandboxPort;
  allowHostTestAdapters?: boolean;
  attemptSandboxRepository?: AttemptSandboxRepositoryPort;
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
  bindingSource: 'sandbox' | 'default' | 'injected' | 'built-in' | 'custom-cli' | 'unbound';
  adapterName: string | null;
}

function withLongResearchTimeoutDefaults<T extends AdapterFactoryConfig>(config: T): T {
  return {
    ...config,
    timeout: Math.max(config.timeout, 900),
    maxDuration: Math.max(config.maxDuration ?? 0, 7200),
  };
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
    const allowHostTestAdapters = this.deps.allowHostTestAdapters ?? process.env.NODE_ENV === 'test';
    if (allowHostTestAdapters && name === this.deps.defaultExecutor.name) {
      return this.deps.defaultExecutorFactory?.() ?? this.deps.defaultExecutor;
    }
    const injectedTestAdapter = allowHostTestAdapters ? this.deps.executorFactory?.(name) : null;
    if (injectedTestAdapter) return injectedTestAdapter;
    if (this.deps.attemptSandbox && this.deps.agentClassLookup) {
      const agentClass = this.deps.agentClassLookup.findByName(name);
      return agentClass
        ? new SandboxedExecutorAdapter(agentClass, this.deps.attemptSandbox, this.deps.attemptSandboxRepository)
        : null;
    }
    if (!allowHostTestAdapters) return null;

    const registered = this.adapterRegistry.create(name, {
      timeout: this.deps.config.executor.timeout,
      maxDuration: this.deps.config.executor.max_duration,
      workspaceRoot: process.cwd(),
    });
    if (registered) {
      return registered;
    }

    const customAgentClass = this.deps.agentClassLookup?.findByName(name);
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

  inspect(name: string): ExecutorRegistrationInspection {
    const allowHostTestAdapters = this.deps.allowHostTestAdapters ?? process.env.NODE_ENV === 'test';
    if (allowHostTestAdapters && name === this.deps.defaultExecutor.name) {
      return { configured: true, bindingSource: 'default', adapterName: name };
    }
    const injectedTestAdapter = allowHostTestAdapters ? this.deps.executorFactory?.(name) : null;
    if (injectedTestAdapter) {
      return { configured: true, bindingSource: 'injected', adapterName: injectedTestAdapter.name };
    }
    if (this.deps.attemptSandbox && this.deps.agentClassLookup) {
      const agentClass = this.deps.agentClassLookup.findByName(name);
      const configured = Boolean(
        agentClass?.executionImageRef
        && agentClass.resolvedImageId
        && agentClass.permissionProfileId,
      );
      return { configured, bindingSource: configured ? 'sandbox' : 'unbound', adapterName: configured ? name : null };
    }
    if (!allowHostTestAdapters) {
      return { configured: false, bindingSource: 'unbound', adapterName: null };
    }

    if (this.adapterRegistry.has(name)) {
      return { configured: true, bindingSource: 'built-in', adapterName: name };
    }

    const customAgentClass = this.deps.agentClassLookup?.findByName(name);
    if (customAgentClass?.runtimeCommand) {
      return { configured: true, bindingSource: 'custom-cli', adapterName: name };
    }

    return { configured: false, bindingSource: 'unbound', adapterName: null };
  }

  async isAvailable(name: string): Promise<boolean> {
    const allowHostTestAdapters = this.deps.allowHostTestAdapters ?? process.env.NODE_ENV === 'test';
    if (allowHostTestAdapters) {
      const testAdapter = name === this.deps.defaultExecutor.name
        ? (this.deps.defaultExecutorFactory?.() ?? this.deps.defaultExecutor)
        : this.deps.executorFactory?.(name);
      if (testAdapter) {
        const available = await testAdapter.isAvailable();
        return available !== false;
      }
    }
    if (this.deps.attemptSandbox && this.deps.agentClassLookup) {
      const agentClass = this.deps.agentClassLookup.findByName(name);
      if (agentClass?.executionImageRef && !agentClass.resolvedImageId && getBuiltinExecutorDefinition(name)) {
        try {
          const imageId = await this.deps.attemptSandbox.resolveImage(agentClass.executionImageRef);
          if (!imageId.startsWith('sha256:')) return false;
          this.deps.agentClassLookup.setResolvedImageId?.(name, imageId);
        } catch {
          return false;
        }
      }
    }
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
  const definition = getBuiltinExecutorDefinitions().find(candidate =>
    candidate.name === config.command
    || candidate.adapterBinding.adapterName === config.command
    || candidate.adapterBinding.commandAliases.includes(config.command)
  );
  const legacyNameByCommand: Record<string, string> = {
    claude: 'claude-code',
    'claude-code': 'claude-code',
    hermes: 'hermes-agent',
    'hermes-agent': 'hermes-agent',
    deepseek: 'deepseek-tui',
    'deepseek-tui': 'deepseek-tui',
    openclaw: 'openclaw',
  };
  // Preserve the configured-command normalization used by startup catalog
  // materialization. Unknown legacy commands historically selected Claude;
  // they remain unclassified and, without an image/profile, fail closed at
  // execution time under the Phase 5 sandbox contract.
  const name = definition?.name ?? legacyNameByCommand[config.command] ?? 'claude-code';
  return {
    name,
    async execute() {
      const summary = 'host Executor execution is disabled; a verified attempt image is required';
      return {
        success: false,
        output: '',
        error: summary,
        failure: kernelFailure({ kind: 'configuration', scope: 'agent_class', code: 'sandbox_required', summary }),
        exitCode: 1,
        durationMs: 0,
      };
    },
    async isAvailable() { return false; },
    abort() { /* no host process exists */ },
  };
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
  acceptance: WorkGraphAcceptanceCriterion[];
  expectedOutput: Subtask['expectedOutput'];
}

/** Runs a claimed subtask with its selected executor and converts adapter output into the shared ExecutionResult shape. */
export class ExecutionRuntime implements ActiveExecutionControl {
  private readonly activeByTask = new Map<string, Map<string, {
    attemptId: string;
    workUnitId: string;
    executor: ExecutorAdapter;
  }>>();
  private executionTokenSequence = 0;

  constructor(
    private readonly registry: ExecutorRegistry,
    _defaultExecutor: ExecutorAdapter,
  ) {}

  isExecutorAvailable(name: string): Promise<boolean> {
    return this.registry.isAvailable(name);
  }

  supportsResponseOnly(name: string): boolean {
    return typeof this.registry.resolve(name)?.executeResponseOnly === 'function';
  }

  supportsContinuation(name: string): boolean {
    return this.registry.resolve(name)?.supportsContinuation === true;
  }

  async runResponseOnly(agentClassName: string, prompt: string, maxBytes: number) {
    const executor = this.registry.resolve(agentClassName);
    if (!executor?.executeResponseOnly) return null;
    return executor.executeResponseOnly({ prompt, maxBytes });
  }

  inspectExecutorRegistration(name: string): ExecutorRegistrationInspection {
    return this.registry.inspect(name);
  }

  async run(input: ExecutionRuntimeRunInput): Promise<ExecutionResult> {
    const executor = this.registry.resolve(input.spec.agentClass.name);
    if (!executor) {
      const summary = `No Executor Adapter is configured for AgentClass ${input.spec.agentClass.name}`;
      return {
        taskId: input.taskId,
        executionId: input.executionId,
        status: 'failed',
        executorName: input.spec.agentClass.name,
        output: '',
        error: summary,
        failure: kernelFailure({
          kind: 'configuration',
          scope: 'agent_class',
          code: 'executor_adapter_unbound',
          summary,
        }),
        artifacts: [],
        subtaskResults: [],
        durationMs: 0,
        userPrompt: input.executorInput.context.currentSubtask.goal,
        preferences: [],
        context: input.executorInput.context,
      };
    }
    const executionToken = `${input.executionId}:${input.spec.workUnit.id}:${this.executionTokenSequence += 1}`;
    this.registerActive(
      input.taskId,
      executionToken,
      input.executorInput.context.identity.attemptId,
      input.spec.workUnit.id,
      executor,
    );
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
      });
    } finally {
      this.clearActive(input.taskId, executionToken);
    }
  }

  abortAttempt(taskId: string, attemptId: string): boolean {
    const active = this.activeByTask.get(taskId);
    const entry = active
      ? [...active.values()].find(candidate => candidate.attemptId === attemptId)
      : null;
    if (!entry) return false;
    entry.executor.abort(attemptId);
    return true;
  }

  abortTask(taskId: string): number {
    const active = this.activeByTask.get(taskId);
    if (!active || active.size === 0) {
      return 0;
    }

    for (const entry of active.values()) {
      entry.executor.abort(entry.attemptId);
    }
    return active.size;
  }

  private registerActive(
    taskId: string,
    executionToken: string,
    attemptId: string,
    workUnitId: string,
    executor: ExecutorAdapter,
  ): void {
    const active = this.activeByTask.get(taskId) ?? new Map();
    active.set(executionToken, { attemptId, workUnitId, executor });
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
      failure: input.result.failure ?? null,
      artifacts: input.subtaskResults.flatMap(result => result.artifacts),
      subtaskResults: input.subtaskResults,
      durationMs: input.result.durationMs,
      userPrompt: input.input.executorInput.context.currentSubtask.goal,
      preferences: [],
      context: input.input.executorInput.context,
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
