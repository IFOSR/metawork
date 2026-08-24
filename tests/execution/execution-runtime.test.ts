import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimeConfigurationView,
  RuntimePrivateConfigurationBinding,
} from '../../src/configuration/types.js';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import { kernelFailure } from '../../src/core/kernel-failure.js';
import type { AgentClass, ExecutorResult, Subtask, WorkUnit } from '../../src/core/types.js';
import { ExecutionRuntime, ExecutorRegistry } from '../../src/execution/execution-runtime.js';
import type {
  ExecutorAdapter,
  ExecutorInput,
  ExecutorProbeResult,
} from '../../src/executor/adapter.js';
import type { HarnessDriverAdapterFactoryInput } from '../../src/executor/harness-driver-registry.js';

const revisionId = 'revision-10';

type FakeHarnessDriverRegistry = {
  createAdapter: ReturnType<typeof vi.fn<(input: {
    configuration: RuntimeConfigurationView;
    authorizedBinding: AuthorizedExecutorBinding;
    runtimeBinding: RuntimePrivateConfigurationBinding;
  }) => ExecutorAdapter>>;
};

function createAuthorizedBinding(
  overrides: Partial<AuthorizedExecutorBinding> = {},
): AuthorizedExecutorBinding {
  return {
    agentClassRef: 'implementation-alpha',
    harnessRef: 'shared-harness',
    providerRef: 'provider-main',
    modelRef: 'model-engineering',
    permissionProfileRef: 'workspace-default',
    configurationRevision: revisionId,
    ...overrides,
  };
}

function createRuntimeBinding(
  binding: AuthorizedExecutorBinding,
  overrides: Partial<RuntimePrivateConfigurationBinding> = {},
): RuntimePrivateConfigurationBinding {
  return {
    revisionId: binding.configurationRevision,
    bindingFingerprint: `private:${binding.agentClassRef}:${binding.modelRef}`,
    ...overrides,
  };
}

function createRuntimeConfiguration(
  overrides: Partial<RuntimeConfigurationView> = {},
): RuntimeConfigurationView {
  return {
    revisionId,
    contentHash: 'sha256:revision-10',
    schemaVersion: 2,
    providers: {
      'provider-main': {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKeyRef: 'keychain:anyfusion/provider-main',
        region: 'international',
        enabled: true,
      },
    },
    models: {
      'model-engineering': {
        providerRef: 'provider-main',
        modelId: 'engineering-v1',
        capabilities: ['coding', 'tools'],
        reasoning: 'medium',
        enabled: true,
      },
      'model-review': {
        providerRef: 'provider-main',
        modelId: 'review-v1',
        capabilities: ['coding', 'structured-output'],
        reasoning: 'high',
        enabled: true,
      },
    },
    harnesses: {
      'shared-harness': {
        kind: 'executor',
        transport: 'local-cli',
        command: 'codex',
        args: [],
        driverId: 'codex-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
    },
    agentClasses: {
      'implementation-alpha': runtimeAgentClass('model-engineering'),
      'quality-beta': runtimeAgentClass('model-review'),
    },
    permissionProfiles: {
      'workspace-default': {
        profileId: 'workspace-engineering',
        version: 1,
        parameters: {},
      },
    },
    runtimePolicy: {},
    gateway: {},
    ...overrides,
  };
}

function runtimeAgentClass(modelRef: string) {
  return {
    kind: 'executor' as const,
    harnessRef: 'shared-harness',
    modelPolicy: { mode: 'fixed' as const, modelRef },
    permissionProfileRef: 'workspace-default',
    routingCapabilities: ['workspace-engineering' as const],
    primaryUseCases: [],
    avoidUseCases: [],
    plannerAffordances: ['workspace-read-write' as const],
    skills: [],
    mcpServers: [],
    plugins: [],
    generatedRuntimeRef: 'generated-runtime',
    enabled: true,
  };
}

function createAdapter(
  name: string,
  overrides: Partial<ExecutorAdapter> = {},
): ExecutorAdapter {
  return {
    name,
    execute: vi.fn(async (): Promise<ExecutorResult> => ({
      success: true,
      output: `completed:${name}`,
      exitCode: 0,
      durationMs: 5,
    })),
    probe: vi.fn(async (): Promise<ExecutorProbeResult> => ({
      available: true,
      failure: null,
    })),
    abort: vi.fn(),
    ...overrides,
  };
}

function createHarnessDriverRegistry(
  create: (input: HarnessDriverAdapterFactoryInput) => ExecutorAdapter = input => (
    createAdapter(`${input.authorizedBinding.agentClassRef}:${input.runtimeBinding.bindingFingerprint}`)
  ),
): FakeHarnessDriverRegistry {
  return {
    createAdapter: vi.fn(input => create(input as HarnessDriverAdapterFactoryInput)),
  };
}

function createRegistry(input: {
  configuration?: RuntimeConfigurationView;
  harnessDriverRegistry?: FakeHarnessDriverRegistry;
  getRuntimeConfiguration?: (revisionId: string) => RuntimeConfigurationView | null;
  getRuntimeBinding?: (
    binding: AuthorizedExecutorBinding,
  ) => Promise<RuntimePrivateConfigurationBinding>;
} = {}) {
  const configuration = input.configuration ?? createRuntimeConfiguration();
  const harnessDriverRegistry = input.harnessDriverRegistry ?? createHarnessDriverRegistry();
  const getRuntimeConfiguration = vi.fn(
    input.getRuntimeConfiguration ?? (() => configuration),
  );
  const getRuntimeBinding = vi.fn(
    input.getRuntimeBinding ?? (async binding => createRuntimeBinding(binding)),
  );
  const registry = new ExecutorRegistry({
    driverRegistry: harnessDriverRegistry,
    getRuntimeConfiguration,
    getRuntimeBinding,
    getActiveRuntimeConfiguration: () => configuration,
  });
  return {
    registry,
    harnessDriverRegistry,
    getRuntimeConfiguration,
    getRuntimeBinding,
  };
}

function createAgentClass(name = 'implementation-alpha'): AgentClass {
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
    executionImageRef: null,
    resolvedImageId: null,
    permissionProfileId: null,
    projectUrl: null,
  };
}

function createSubtask(): Subtask {
  return {
    id: 'subtask_runtime',
    taskId: 'task_runtime',
    graphRevision: 1,
    generationId: 'gen_runtime',
    title: 'Runtime subtask',
    goal: 'execute runtime subtask',
    status: 'running',
    dependencies: [],
    contextRefs: [],
    requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList: ['implementation-alpha'],
    deliveryKind: 'report',
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }],
    riskLevel: 'medium',
    result: '',
    artifacts: [],
    verification: { warnings: [], completionSchemaVersion: null },
    error: null,
    createdAt: '2026-08-13T00:00:00Z',
    updatedAt: '2026-08-13T00:00:00Z',
  };
}

function createWorkUnit(agentClassName = 'implementation-alpha'): WorkUnit {
  return {
    id: 'executor-1',
    agentClassName,
    agentClassKind: 'executor',
    state: 'running',
    claimedTaskId: 'task_runtime',
    claimedSubtaskId: 'subtask_runtime',
    claimedAttemptId: 'attempt_runtime',
    heartbeatAt: '2026-08-13T00:00:00Z',
    leaseExpiresAt: null,
    createdAt: '2026-08-13T00:00:00Z',
    updatedAt: '2026-08-13T00:00:00Z',
  };
}

function createExecutionBinding(): NonNullable<ExecutorInput['executionBinding']> {
  return {
    attemptId: 'attempt_runtime',
    taskId: 'task_runtime',
    generationId: 'gen_runtime',
    subtaskId: 'subtask_runtime',
    workUnitId: 'executor-1',
    leaseToken: 'lease_runtime',
    idempotencyKey: 'idem_runtime',
    workspacePath: process.cwd(),
    workspaceId: 'workspace_runtime',
    sourcePath: process.cwd(),
    inputsPath: process.cwd(),
    handoffsPath: process.cwd(),
    gitMetadataPath: null,
    controlNetwork: 'metaclaw-control',
    capabilityBinding: null,
    onExecutionCreated: undefined,
  };
}

function createExecutorInput(): Omit<ExecutorInput, 'onProgress'> {
  const subtask = createSubtask();
  return {
    context: {
      taskBackground: {
        id: 'task_runtime',
        title: 'runtime task',
        goal: 'execute runtime task',
        instruction: 'background_only',
      },
      currentSubtask: {
        id: subtask.id,
        title: subtask.title,
        goal: subtask.goal,
        deliveryKind: subtask.deliveryKind,
        acceptance: subtask.acceptance,
      },
      incomingHandoffs: [],
      outgoingHandoffRequirements: [],
      selectedEvidence: [],
      outOfScopeSiblings: [],
      workspaceContext: {
        allowFilesystem: true,
        workingDirectory: process.cwd(),
        targetPaths: [],
      },
      identity: {
        executionId: 'exec_runtime',
        taskId: 'task_runtime',
        subtaskId: subtask.id,
        attemptId: 'attempt_runtime',
        workUnitId: 'executor-1',
      },
      completionContract: {
        marker: '<!-- metaclaw:completion:v2 -->',
        schemaVersion: 2,
      },
      evidenceTools: { availability: 'unavailable', reason: 'unit test' },
    },
    executionBinding: createExecutionBinding(),
  };
}

function createRunInput(
  authorizedBinding: AuthorizedExecutorBinding = createAuthorizedBinding(),
  overrides: { taskId?: string; executionId?: string } = {},
) {
  const taskId = overrides.taskId ?? 'task_runtime';
  const executionId = overrides.executionId ?? 'exec_runtime';
  return {
    taskId,
    executionId,
    authorizedBinding,
    spec: {
      subtask: createSubtask(),
      workUnit: createWorkUnit(authorizedBinding.agentClassRef),
      agentClass: createAgentClass(authorizedBinding.agentClassRef),
      acceptance: [],
      deliveryKind: 'report' as const,
    },
    executorInput: createExecutorInput(),
    onProgress: vi.fn(),
  };
}

describe('ExecutorRegistry', () => {
  it('does not expose an implicit Runtime binding for Auto AgentClasses', () => {
    const configuration = createRuntimeConfiguration({
      agentClasses: {
        'implementation-alpha': {
          ...runtimeAgentClass('model-engineering'),
          modelPolicy: {
            mode: 'auto',
            allowedModelRefs: ['model-engineering', 'model-review'],
            defaultModelRef: 'model-engineering',
          },
        },
      },
    });
    const { registry } = createRegistry({ configuration });

    expect(registry.bindingForAgentClass('implementation-alpha', revisionId)).toBeNull();
  });

  it('creates distinct adapters and private bindings for two AgentClasses using the same driver', async () => {
    const harnessDriverRegistry = createHarnessDriverRegistry();
    const { registry, getRuntimeConfiguration, getRuntimeBinding } = createRegistry({
      harnessDriverRegistry,
    });
    const implementation = createAuthorizedBinding();
    const review = createAuthorizedBinding({
      agentClassRef: 'quality-beta',
      modelRef: 'model-review',
    });

    const implementationAdapter = await registry.resolve(implementation);
    const reviewAdapter = await registry.resolve(review);

    expect(implementationAdapter).not.toBe(reviewAdapter);
    expect(implementationAdapter?.name).toContain('implementation-alpha');
    expect(reviewAdapter?.name).toContain('quality-beta');
    expect(getRuntimeConfiguration).toHaveBeenNthCalledWith(1, revisionId);
    expect(getRuntimeConfiguration).toHaveBeenNthCalledWith(2, revisionId);
    expect(getRuntimeBinding).toHaveBeenNthCalledWith(1, implementation);
    expect(getRuntimeBinding).toHaveBeenNthCalledWith(2, review);
    expect(harnessDriverRegistry.createAdapter).toHaveBeenNthCalledWith(1, {
      configuration: expect.objectContaining({ revisionId }),
      authorizedBinding: implementation,
      runtimeBinding: createRuntimeBinding(implementation),
    });
    expect(harnessDriverRegistry.createAdapter).toHaveBeenNthCalledWith(2, {
      configuration: expect.objectContaining({ revisionId }),
      authorizedBinding: review,
      runtimeBinding: createRuntimeBinding(review),
    });
  });

  it('fails closed before adapter creation when the configuration revision mismatches', async () => {
    const harnessDriverRegistry = createHarnessDriverRegistry(input => {
      if (input.configuration.revisionId !== input.authorizedBinding.configurationRevision) {
        throw new Error('configuration revision mismatch');
      }
      return createAdapter('unexpected');
    });
    const { registry } = createRegistry({
      harnessDriverRegistry,
      getRuntimeConfiguration: () => createRuntimeConfiguration({
        revisionId: 'revision-11',
        contentHash: 'sha256:revision-11',
      }),
    });

    await expect(registry.resolve(createAuthorizedBinding()))
      .rejects.toThrow('configuration revision mismatch');
    expect(harnessDriverRegistry.createAdapter).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the selected binding does not match the revision projection', async () => {
    const harnessDriverRegistry = createHarnessDriverRegistry(input => {
      const configured = input.configuration.agentClasses[input.authorizedBinding.agentClassRef];
      if (!configured || configured.harnessRef !== input.authorizedBinding.harnessRef) {
        throw new Error('authorized binding mismatch');
      }
      return createAdapter('unexpected');
    });
    const { registry } = createRegistry({ harnessDriverRegistry });

    await expect(registry.resolve(createAuthorizedBinding({
      harnessRef: 'invented-harness',
    }))).rejects.toThrow('authorized binding mismatch');
    expect(harnessDriverRegistry.createAdapter).toHaveBeenCalledTimes(1);
  });

  it('probes the adapter selected by the complete authorized binding', async () => {
    const previousFailure = kernelFailure({
      kind: 'network',
      scope: 'agent_class',
      code: 'provider_unreachable',
      summary: 'provider was unreachable',
    });
    const adapter = createAdapter('quality-beta');
    const harnessDriverRegistry = createHarnessDriverRegistry(() => adapter);
    const { registry, getRuntimeBinding } = createRegistry({ harnessDriverRegistry });
    const binding = createAuthorizedBinding({
      agentClassRef: 'quality-beta',
      modelRef: 'model-review',
    });

    await expect(registry.probe(binding, previousFailure)).resolves.toEqual({
      available: true,
      failure: null,
    });
    expect(getRuntimeBinding).toHaveBeenCalledWith(binding);
    expect(harnessDriverRegistry.createAdapter).toHaveBeenCalledWith({
      configuration: expect.objectContaining({ revisionId }),
      authorizedBinding: binding,
      runtimeBinding: createRuntimeBinding(binding),
    });
    expect(adapter.probe).toHaveBeenCalledWith(previousFailure);
  });
});

describe('ExecutionRuntime', () => {
  it('runs through the adapter selected by the explicit authorized binding', async () => {
    const adapter = createAdapter('implementation-alpha');
    const { registry } = createRegistry({
      harnessDriverRegistry: createHarnessDriverRegistry(() => adapter),
    });
    const runtime = new ExecutionRuntime(registry);
    const binding = createAuthorizedBinding();

    const result = await runtime.run(createRunInput(binding));

    expect(result).toMatchObject({
      status: 'success',
      executorName: 'implementation-alpha',
      output: 'completed:implementation-alpha',
      error: null,
    });
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });

  it('preserves structured adapter failure normalization', async () => {
    const failure = kernelFailure({
      kind: 'authentication',
      scope: 'attempt',
      code: 'provider_authentication_failed',
      summary: 'provider rejected the selected private binding',
    });
    const adapter = createAdapter('implementation-alpha', {
      execute: vi.fn(async () => ({
        success: false,
        output: '',
        error: failure.summary,
        failure,
        exitCode: 1,
        durationMs: 7,
      })),
    });
    const { registry } = createRegistry({
      harnessDriverRegistry: createHarnessDriverRegistry(() => adapter),
    });

    const result = await new ExecutionRuntime(registry).run(createRunInput());

    expect(result).toMatchObject({
      status: 'failed',
      executorName: 'implementation-alpha',
      output: '',
      error: failure.summary,
      failure,
      durationMs: 7,
    });
  });

  it('normalizes an adapter exception into a failed execution result', async () => {
    const adapter = createAdapter('implementation-alpha', {
      execute: vi.fn(async () => {
        throw new Error('driver process failed');
      }),
    });
    const { registry } = createRegistry({
      harnessDriverRegistry: createHarnessDriverRegistry(() => adapter),
    });

    const result = await new ExecutionRuntime(registry).run(createRunInput());

    expect(result).toMatchObject({
      status: 'failed',
      executorName: 'implementation-alpha',
      output: '',
      error: 'driver process failed',
      durationMs: 0,
    });
  });

  it('tracks aborts per active task and clears them after each run', async () => {
    const releases = new Map<string, () => void>();
    const adapters: ExecutorAdapter[] = [];
    const harnessDriverRegistry = createHarnessDriverRegistry(input => {
      const adapter = createAdapter(input.authorizedBinding.agentClassRef, {
        execute: vi.fn(() => new Promise<ExecutorResult>(resolve => {
          releases.set(input.authorizedBinding.agentClassRef, () => resolve({
            success: false,
            output: '',
            error: 'cancelled',
            exitCode: 130,
            durationMs: 1,
            interrupted: true,
          }));
        })),
      });
      adapters.push(adapter);
      return adapter;
    });
    const { registry } = createRegistry({ harnessDriverRegistry });
    const runtime = new ExecutionRuntime(registry);
    const firstBinding = createAuthorizedBinding();
    const secondBinding = createAuthorizedBinding({
      agentClassRef: 'quality-beta',
      modelRef: 'model-review',
    });

    const firstRun = runtime.run(createRunInput(firstBinding, {
      taskId: 'task_first',
      executionId: 'exec_first',
    }));
    const secondRun = runtime.run(createRunInput(secondBinding, {
      taskId: 'task_second',
      executionId: 'exec_second',
    }));
    await vi.waitFor(() => expect(adapters).toHaveLength(2));

    expect(runtime.abortTask('task_first')).toBe(1);
    expect(adapters[0]!.abort).toHaveBeenCalledWith('attempt_runtime');
    expect(adapters[1]!.abort).not.toHaveBeenCalled();

    releases.get('implementation-alpha')!();
    releases.get('quality-beta')!();
    await Promise.all([firstRun, secondRun]);

    expect(runtime.abortTask('task_first')).toBe(0);
    expect(runtime.abortTask('task_second')).toBe(0);
  });
});
