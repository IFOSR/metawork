import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';
import type { RuntimePrivateConfigurationBinding } from '../../src/configuration/types.js';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import { COMPLETION_MARKER_V3 } from '../../src/execution/completion-protocol.js';
import type {
  AttemptExecutionBackend,
  CreateAttemptExecutionInput,
} from '../../src/execution/attempt-execution-backend.js';
import type { ExecutorInput } from '../../src/executor/adapter.js';
import {
  ContainerCompatibilityAdapter,
} from '../../src/executor/container-compatibility-adapter.js';
import type { HarnessDriver } from '../../src/executor/harness-driver.js';

describe('ContainerCompatibilityAdapter', () => {
  it.each(['verified', 'unavailable'] as const)('requires an in-image program probe before managed business execution: %s', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'container-manifest-'));
    try {
      mkdirSync(join(root, 'home'));
      const driver = harnessDriver('selected-container-driver');
      vi.mocked(driver.materializeHome).mockResolvedValue({ homePath: join(root, 'home'), environment: {} });
      const { backend, create } = backendPort();
      backend.probeProgram = vi.fn(async () => {
        if (mode === 'unavailable') throw new Error('image executable missing');
        return 'pi 1.2.0';
      });
      const authorized = authorizedBinding();
      const runtime: RuntimePrivateConfigurationBinding = { revisionId: authorized.configurationRevision,
        bindingFingerprint: authorizedExecutorBindingFingerprint(authorized),
        environment: { OPENAI_BASE_URL: 'https://test.invalid/v1', OPENAI_MODEL: 'deepseek-v4-pro', OPENAI_API_KEY: 'secret-test-only' },
        manifest: { driverId: driver.id, protocol: 'openai-compatible', baseUrl: 'https://test.invalid/v1',
          modelId: 'deepseek-v4-pro', permissionProfileRef: authorized.permissionProfileRef } };
      const adapter = new ContainerCompatibilityAdapter({ agentClassId: authorized.agentClassRef, driver,
        runtimeBinding: runtime, authorizedBinding: authorized, modelId: 'deepseek-v4-pro', attemptsRoot: root,
        imageRef: 'executor:mutable-tag', backend });
      const result = await adapter.execute(executorInput('attempt-1'));
      expect(backend.probeProgram).toHaveBeenCalledWith('sha256:selected', 'selected-driver-command');
      if (mode === 'unavailable') {
        expect(result.success).toBe(false);
        expect(create).not.toHaveBeenCalled();
      } else {
        expect(result.success).toBe(true);
        expect(create).toHaveBeenCalledOnce();
        const text = readFileSync(join(root, 'runtime-manifest.json'), 'utf8');
        expect(JSON.parse(text)).toMatchObject({ version: 'pi 1.2.0', imageId: 'sha256:selected',
          bindingFingerprint: runtime.bindingFingerprint, workspacePath: '/workspace', inputsPath: '/inputs' });
        expect(text).not.toContain('secret-test-only');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('runs an arbitrary AgentClass through the explicitly selected Harness driver', async () => {
    const driver = harnessDriver('selected-container-driver');
    const { backend, create } = backendPort();
    const adapter = new ContainerCompatibilityAdapter({
      agentClassId: 'arbitrary-agent-class',
      driver,
      runtimeBinding: runtimeBinding(),
      authorizedBinding: { ...authorizedBinding(), agentClassRef: 'arbitrary-agent-class' },
      modelId: 'deepseek-v4-pro',
      attemptsRoot: '/runtime/attempts',
      imageRef: 'anyfusion/executor:selected',
      backend,
      runtimeEnvironment: {
        ATTEMPT_MODEL_TOKEN: 'scoped-token',
      },
      egressMode: 'proxy',
      nestedSandbox: 'codex-workspace-write',
    });

    const result = await adapter.execute(executorInput('attempt-1'));

    expect(driver.materializeHome).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      revisionId: 'revision-10',
      agentClassId: 'arbitrary-agent-class',
      bindingFingerprint: 'binding-fingerprint',
      attemptsRoot: '/runtime/attempts',
      environment: {},
      evidenceToolsAvailable: true,
    });
    expect(driver.buildLaunch).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('Working directory: /workspace'),
      cwd: '/workspace',
      runtimeHomePath: '/runtime-home',
      providerRef: 'deepseek',
      modelId: 'deepseek-v4-pro',
      executionTarget: 'container',
    }));
    const prompt = vi.mocked(driver.buildLaunch).mock.calls[0]![0].prompt;
    expect(prompt).toContain('Input directory relative to the working directory: "../inputs"');
    expect(prompt).not.toContain('/host/inputs');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-1',
      imageRef: 'anyfusion/executor:selected',
      resolvedImageId: 'sha256:selected',
      command: 'selected-driver-command',
      args: ['--execute'],
      environment: expect.objectContaining({
        DRIVER_LAUNCH: 'selected',
        ATTEMPT_MODEL_TOKEN: 'scoped-token',
        METACLAW_ATTEMPT_ID: 'attempt-1',
        METACLAW_CAPABILITY_TOKEN: 'capability-token',
        METACLAW_EVIDENCE_TOKEN: 'evidence-token',
      }),
      mounts: expect.arrayContaining([
        { source: '/runtime/attempts/attempt-1/home', target: '/runtime-home', mode: 'rw' },
        { source: '/host/workspaces/attempt-1', target: '/workspace', mode: 'rw' },
        { source: '/host/source', target: '/source', mode: 'ro' },
        { source: '/host/inputs', target: '/inputs', mode: 'ro' },
        { source: '/host/handoffs', target: '/handoffs', mode: 'ro' },
      ]),
      egressMode: 'proxy',
      nestedSandbox: 'codex-workspace-write',
    }));
    expect(result).toMatchObject({
      success: true,
      output: 'normalized /host/workspaces/attempt-1/result',
      exitCode: 0,
    });
  });

  it('normalizes container output only through the selected driver', async () => {
    const driver = harnessDriver('custom-driver', {
      success: false,
      output: '',
      error: 'driver-normalized failure',
    });
    const { backend, logs } = backendPort({
      exitCode: 29,
      logs: 'raw container failure',
    });
    const adapter = new ContainerCompatibilityAdapter({
      agentClassId: 'codex-cli',
      driver,
      runtimeBinding: runtimeBinding(),
      authorizedBinding: { ...authorizedBinding(), agentClassRef: 'codex-cli' },
      modelId: 'deepseek-v4-pro',
      attemptsRoot: '/runtime/attempts',
      imageRef: 'anyfusion/executor:custom',
      backend,
    });

    const result = await adapter.execute(executorInput('attempt-29'));

    expect(logs).toHaveBeenCalledWith('container_attempt-29');
    expect(driver.parseResult).toHaveBeenCalledWith({
      exitCode: 29,
      stdout: 'raw container failure',
      stderr: 'raw container failure',
    });
    expect(result).toMatchObject({
      success: false,
      output: '',
      error: 'driver-normalized failure',
      exitCode: 29,
    });
  });

  it('fails closed before selecting container behavior when execution binding is missing', async () => {
    const driver = harnessDriver('selected-container-driver');
    const { backend, create } = backendPort();
    const adapter = new ContainerCompatibilityAdapter({
      agentClassId: 'pi-agent',
      driver,
      runtimeBinding: runtimeBinding(),
      authorizedBinding: { ...authorizedBinding(), agentClassRef: 'pi-agent' },
      modelId: 'deepseek-v4-pro',
      attemptsRoot: '/runtime/attempts',
      imageRef: 'anyfusion/executor:selected',
      backend,
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
    expect(driver.buildLaunch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('aborts only the requested attempt container', async () => {
    const driver = harnessDriver('selected-container-driver');
    const waitResolvers = new Map<string, (exitCode: number) => void>();
    const { backend, create, stop } = backendPort({
      wait: containerId => new Promise(resolve => {
        waitResolvers.set(containerId, resolve);
      }),
    });
    const adapter = new ContainerCompatibilityAdapter({
      agentClassId: 'shared-agent-class',
      driver,
      runtimeBinding: runtimeBinding(),
      authorizedBinding: { ...authorizedBinding(), agentClassRef: 'shared-agent-class' },
      modelId: 'deepseek-v4-pro',
      attemptsRoot: '/runtime/attempts',
      imageRef: 'anyfusion/executor:selected',
      backend,
    });

    const first = adapter.execute(executorInput('attempt-1'));
    const second = adapter.execute(executorInput('attempt-2'));
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    adapter.abort('attempt-1');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('container_attempt-1');
    waitResolvers.get('container_attempt-1')?.(0);
    waitResolvers.get('container_attempt-2')?.(0);
    await Promise.all([first, second]);
  });

  it('probes the selected executable inside the image even if it is absent on the host', async () => {
    const driver = harnessDriver('selected-container-driver');
    vi.mocked(driver.probe).mockResolvedValue({ available: false, detail: 'not installed on host' });
    const { backend, resolveImage } = backendPort();
    backend.probeProgram = vi.fn(async () => 'pi 1.2.0');
    const adapter = new ContainerCompatibilityAdapter({
      agentClassId: 'agent-class-with-no-name-contract',
      driver,
      runtimeBinding: runtimeBinding(),
      authorizedBinding: { ...authorizedBinding(), agentClassRef: 'agent-class-with-no-name-contract' },
      modelId: 'deepseek-v4-pro',
      attemptsRoot: '/runtime/attempts',
      imageRef: 'anyfusion/executor:selected',
      backend,
    });

    const result = await adapter.probe();

    expect(driver.probe).not.toHaveBeenCalled();
    expect(backend.probeProgram).toHaveBeenCalledWith('sha256:selected', 'selected-driver-command');
    expect(resolveImage).toHaveBeenCalledWith('anyfusion/executor:selected');
    expect(result).toEqual({ available: true, failure: null });
  });
});

function runtimeBinding(): RuntimePrivateConfigurationBinding {
  return {
    revisionId: 'revision-10',
    bindingFingerprint: 'binding-fingerprint',
  };
}

function authorizedBinding(): AuthorizedExecutorBinding {
  return {
    agentClassRef: 'pi-agent',
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
    output: 'normalized /workspace/result',
  },
): HarnessDriver {
  return {
    id,
    probe: vi.fn(async () => ({ available: true })),
    materializeHome: vi.fn(async input => ({
      homePath: `${input.attemptsRoot}/${input.attemptId}/home`,
      environment: { DRIVER_HOST_HOME: `${input.attemptsRoot}/${input.attemptId}/home` },
    })),
    buildLaunch: vi.fn(input => ({
      command: 'selected-driver-command',
      args: ['--execute'],
      cwd: input.cwd,
      environment: {
        DRIVER_LAUNCH: 'selected',
        DRIVER_RUNTIME_HOME: input.runtimeHomePath,
      },
    })),
    parseResult: vi.fn(() => parsedResult),
  };
}

function backendPort(options: {
  exitCode?: number;
  logs?: string;
  wait?: (containerId: string) => Promise<number>;
} = {}): {
  backend: AttemptExecutionBackend;
  create: ReturnType<typeof vi.fn>;
  logs: ReturnType<typeof vi.fn>;
  resolveImage: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const resolveImage = vi.fn(async () => 'sha256:selected');
  const create = vi.fn(async (input: CreateAttemptExecutionInput) => ({
    containerId: `container_${input.attemptId}`,
    imageId: input.resolvedImageId,
    status: 'created' as const,
    exitCode: null,
    labels: {},
  }));
  const logs = vi.fn(async () => options.logs ?? 'raw container output');
  const stop = vi.fn(async () => undefined);
  return {
    create,
    logs,
    resolveImage,
    stop,
    backend: {
      kind: 'container',
      pathMode: 'container',
      resolveImage,
      create,
      start: vi.fn(async () => undefined),
      wait: vi.fn(options.wait ?? (async () => options.exitCode ?? 0)),
      logs,
      pause: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      inspect: vi.fn(async () => null),
      stop,
      remove: vi.fn(async () => undefined),
      listManaged: vi.fn(async () => []),
    },
  };
}

function executorInput(attemptId: string): ExecutorInput {
  const workspacePath = `/host/workspaces/${attemptId}`;
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
        title: 'Container compatibility',
        goal: 'Execute the selected container Harness',
        deliveryKind: 'edit',
        requiredCapabilities: [],
        acceptance: [],
      },
      incomingHandoffs: [],
      outgoingHandoffRequirements: [],
      selectedEvidence: [],
      outOfScopeSiblings: [],
      workspaceContext: {
        allowFilesystem: true,
        workingDirectory: workspacePath,
        targetPaths: [workspacePath, `${workspacePath}/src`],
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
        reason: null,
        binding: {
          mcpUrl: 'http://metaclaw-control/evidence/mcp',
          jsonUrl: 'http://metaclaw-control/evidence/json',
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
      idempotencyKey: `dispatch-${attemptId}`,
      workspacePath,
      workspaceId: 'workspace-1',
      sourcePath: '/host/source',
      inputsPath: '/host/inputs',
      handoffsPath: '/host/handoffs',
      gitMetadataPath: null,
      controlNetwork: 'metaclaw-control',
      capabilityBinding: {
        mcpUrl: 'http://metaclaw-control/capability/mcp',
        jsonUrl: 'http://metaclaw-control/capability/json',
        useUrl: 'http://metaclaw-control/capability/use',
        bearerToken: 'capability-token',
      },
    },
  };
}
