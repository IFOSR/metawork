// Resolves executor adapters and runs claimed subtask specs through the execution result normalization path.
import type {
  ExecutorAdapter,
  ExecutorInput,
  ExecutorProbeResult,
  ExecutorProgressEvent,
} from '../executor/adapter.js';
import type { ExecutorResult, ResolvedPreference, Subtask, WorkUnit } from '../core/types.js';
import type { SubtaskExecutionContext } from './subtask-execution-context.js';
import type { SubtaskResult } from './execution-aggregator.js';
import type { ActiveExecutionControl } from './active-execution-control.js';
import type { WorkGraphAcceptanceCriterion } from '../work-graph/index.js';
import { kernelFailure, type KernelFailure } from '../core/kernel-failure.js';
import { authorizedExecutorBindingFingerprint, type AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type {
  RuntimeConfigurationView,
  RuntimePrivateConfigurationBinding,
} from '../configuration/types.js';
import type { HarnessDriverRegistry } from '../executor/harness-driver-registry.js';
import { AutoModelResolver } from '../routing/auto-model-resolver.js';
import { projectConfigurationCandidates } from '../routing/configuration-candidate-projection.js';

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
  driverRegistry: HarnessDriverRegistry;
  getRuntimeConfiguration(revisionId: string): RuntimeConfigurationView | null;
  getRuntimeBinding(
    binding: AuthorizedExecutorBinding,
  ): Promise<RuntimePrivateConfigurationBinding> | RuntimePrivateConfigurationBinding;
  getActiveRuntimeConfiguration(): RuntimeConfigurationView;
}

export interface ExecutorRegistrationInspection {
  configured: boolean;
  bindingSource: 'container' | 'worktree' | 'unbound';
  adapterName: string | null;
}

/** Resolves AgentClasses to the canonical executor adapter and active backend. */
export class ExecutorRegistry {
  constructor(private readonly deps: ExecutorRegistryDeps) {}

  async resolve(binding: AuthorizedExecutorBinding): Promise<ExecutorAdapter | null> {
    const configuration = this.deps.getRuntimeConfiguration(
      binding.configurationRevision,
    );
    if (!configuration) return null;
    return this.deps.driverRegistry.createAdapter({
      configuration,
      authorizedBinding: binding,
      runtimeBinding: await this.deps.getRuntimeBinding(binding),
    });
  }

  inspect(name: string): ExecutorRegistrationInspection {
    const configuration = this.deps.getActiveRuntimeConfiguration();
    const agentClass = configuration.agentClasses[name];
    const harness = agentClass
      ? configuration.harnesses[agentClass.harnessRef]
      : null;
    const configured = Boolean(
      agentClass?.enabled
      && agentClass.kind === 'executor'
      && agentClass.permissionProfileRef
      && harness?.enabled,
    );
    const bindingSource = harness?.transport === 'container'
      ? 'container'
      : harness?.transport === 'local-cli'
        ? 'worktree'
        : 'unbound';
    return {
      configured,
      bindingSource: configured ? bindingSource : 'unbound',
      adapterName: configured ? name : null,
    };
  }

  async probe(
    binding: AuthorizedExecutorBinding,
    previousFailure?: KernelFailure | null,
  ): Promise<ExecutorProbeResult> {
    let adapter: ExecutorAdapter | null;
    try {
      adapter = await this.resolve(binding);
    } catch (error) {
      return {
        available: false,
        failure: kernelFailure({
          kind: 'configuration',
          scope: 'agent_class',
          code: 'executor_binding_resolution_failed',
          summary: error instanceof Error ? error.message : String(error),
        }),
      };
    }
    if (!adapter) {
      return {
        available: false,
        failure: {
          kind: 'configuration',
          scope: 'agent_class',
          code: 'executor_configuration_revision_not_found',
          summary:
            `Runtime configuration revision is not available: ${binding.configurationRevision}`,
        },
      };
    }
    return adapter.probe(previousFailure);
  }

  bindingForAgentClass(
    name: string,
    configurationRevision: string,
  ): AuthorizedExecutorBinding | null {
    const configuration = this.deps.getRuntimeConfiguration(configurationRevision);
    const agentClass = configuration?.agentClasses[name];
    if (
      !configuration
      || !agentClass
      || !agentClass.enabled
      || agentClass.kind !== 'executor'
      || !agentClass.permissionProfileRef
    ) return null;
    if (agentClass.modelPolicy.mode !== 'fixed') return null;
    const modelRef = agentClass.modelPolicy.modelRef;
    if (!modelRef) return null;
    const model = configuration.models[modelRef];
    if (!model?.enabled) return null;
    return {
      agentClassRef: name,
      harnessRef: agentClass.harnessRef,
      providerRef: model.providerRef,
      modelRef,
      permissionProfileRef: agentClass.permissionProfileRef,
      configurationRevision,
    };
  }

  /** Resolves one concrete candidate only for an availability probe. */
  probeBindingForAgentClass(
    name: string,
    configurationRevision: string,
  ): AuthorizedExecutorBinding | null {
    const configuration = this.deps.getRuntimeConfiguration(configurationRevision);
    const agentClass = configuration?.agentClasses[name];
    if (
      !configuration
      || !agentClass
      || !agentClass.enabled
      || agentClass.kind !== 'executor'
      || !agentClass.permissionProfileRef
    ) return null;
    if (agentClass.modelPolicy.mode === 'fixed') {
      return this.bindingForAgentClass(name, configurationRevision);
    }
    const policy = agentClass.modelPolicy;
    const candidates = projectConfigurationCandidates(configuration, name, { mode: policy.mode })
      .filter(candidate => policy.allowedModelRefs.includes(candidate.modelRef));
    try {
      return AutoModelResolver.resolve({
        configurationRevision,
        agentClassRef: name,
        harnessRef: agentClass.harnessRef,
        permissionProfileRef: agentClass.permissionProfileRef,
        policy,
        candidates,
        requirements: { preferredCapabilities: [], contextTokens: 1_024 },
      }).binding;
    } catch {
      return null;
    }
  }

  supportsContinuation(name: string, configurationRevision: string): boolean {
    const configuration = this.deps.getRuntimeConfiguration(configurationRevision);
    return configuration
      ? this.deps.driverRegistry.supportsContinuation({
          configuration,
          agentClassRef: name,
        })
      : false;
  }

  supportsResponseOnly(name: string, configurationRevision: string): boolean {
    const configuration = this.deps.getRuntimeConfiguration(configurationRevision);
    return configuration
      ? this.deps.driverRegistry.supportsResponseOnly({
          configuration,
          agentClassRef: name,
        })
      : false;
  }
}

export interface ExecutionRuntimeRunInput {
  taskId: string;
  executionId: string;
  authorizedBinding: AuthorizedExecutorBinding;
  spec: SubtaskExecutionSpec;
  executorInput: Omit<ExecutorInput, 'onProgress'>;
  onProgress: (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void;
}

export interface SubtaskExecutionSpec {
  subtask: Subtask;
  workUnit: WorkUnit;
  acceptance: WorkGraphAcceptanceCriterion[];
  deliveryKind: Subtask['deliveryKind'];
}

/** Runs a claimed subtask with its selected executor and converts adapter output into the shared ExecutionResult shape. */
export class ExecutionRuntime implements ActiveExecutionControl {
  private readonly activeByTask = new Map<string, Map<string, {
    attemptId: string;
    workUnitId: string;
    executor: ExecutorAdapter;
  }>>();
  private executionTokenSequence = 0;

  constructor(private readonly registry: ExecutorRegistry) {}

  async isExecutorAvailable(binding: AuthorizedExecutorBinding): Promise<boolean> {
    return (await this.registry.probe(binding)).available;
  }

  probeExecutor(
    binding: AuthorizedExecutorBinding,
    previousFailure?: KernelFailure | null,
  ): Promise<ExecutorProbeResult> {
    return this.registry.probe(binding, previousFailure);
  }

  supportsResponseOnly(
    name: string,
    configurationRevision: string,
  ): boolean {
    return this.registry.supportsResponseOnly(name, configurationRevision);
  }

  supportsContinuation(name: string, configurationRevision: string): boolean {
    return this.registry.supportsContinuation(name, configurationRevision);
  }

  async runResponseOnly(
    binding: AuthorizedExecutorBinding,
    prompt: string,
    maxBytes: number,
  ) {
    const executor = await this.registry.resolve(binding);
    if (!executor?.executeResponseOnly) return null;
    return executor.executeResponseOnly({ prompt, maxBytes });
  }

  inspectExecutorRegistration(name: string): ExecutorRegistrationInspection {
    return this.registry.inspect(name);
  }

  async run(input: ExecutionRuntimeRunInput): Promise<ExecutionResult> {
    let executor: ExecutorAdapter | null;
    try {
      executor = await this.registry.resolve(input.authorizedBinding);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      return {
        taskId: input.taskId,
        executionId: input.executionId,
        status: 'failed',
        executorName: input.authorizedBinding.agentClassRef,
        output: '',
        error: summary,
        failure: kernelFailure({
          kind: 'configuration',
          scope: 'agent_class',
          code: 'executor_binding_resolution_failed',
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
    if (!executor) {
      const summary = `No Executor Adapter is configured for AgentClass ${input.authorizedBinding.agentClassRef}`;
      return {
        taskId: input.taskId,
        executionId: input.executionId,
        status: 'failed',
        executorName: input.authorizedBinding.agentClassRef,
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
        {
          ...input.executorInput,
          executionBinding: input.executorInput.executionBinding
            ? {
                ...input.executorInput.executionBinding,
                authorization: {
                  agentClassRef: input.authorizedBinding.agentClassRef,
                  harnessRef: input.authorizedBinding.harnessRef,
                  providerRef: input.authorizedBinding.providerRef,
                  modelRef: input.authorizedBinding.modelRef,
                  permissionProfileRef: input.authorizedBinding.permissionProfileRef,
                  configurationRevision: input.authorizedBinding.configurationRevision,
                  bindingFingerprint: authorizedExecutorBindingFingerprint(input.authorizedBinding),
                },
              }
            : input.executorInput.executionBinding,
        },
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
