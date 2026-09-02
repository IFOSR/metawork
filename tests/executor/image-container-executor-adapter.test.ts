import { describe, expect, it, vi } from 'vitest';
import type { RuntimePrivateConfigurationBinding } from '../../src/configuration/types.js';
import type { AttemptExecutionBackend } from '../../src/execution/attempt-execution-backend.js';
import type { ExecutorInput } from '../../src/executor/adapter.js';
import {
  ImageContainerExecutorAdapter,
} from '../../src/executor/image-container-executor-adapter.js';

describe('ImageContainerExecutorAdapter', () => {
  it('uses an attempt model gateway and never injects the provider secret into the container', async () => {
    const create = vi.fn(async input => ({
      containerId: `container-${input.attemptId}`,
      imageId: input.resolvedImageId,
      status: 'created' as const,
      exitCode: null,
      labels: {},
    }));
    const backend = backendPort(create);
    const close = vi.fn(async () => undefined);
    const gatewayFactory = vi.fn(() => ({
      start: vi.fn(async () => ({
        baseUrl: 'http://metaclaw-control:3210/v1',
        apiKey: 'attempt-token',
      })),
      close,
    }));
    const adapter = new ImageContainerExecutorAdapter({
      agentClassId: 'pi-research',
      authorizedBinding: authorizedBinding(),
      runtimeBinding: runtimeBinding(),
      imageRef: 'metaclaw-executor-pi:phase5',
      backend,
      createGateway: gatewayFactory,
    });

    const result = await adapter.execute(executorInput());

    expect(result).toMatchObject({ success: true, output: '图片完成' });
    expect(gatewayFactory).toHaveBeenCalledWith(expect.objectContaining({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      maxRequestBytes: 64 * 1024 * 1024,
      maxResponseBytes: 64 * 1024 * 1024,
    }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      command: 'node',
      args: ['/opt/metaclaw/image-api-cli.js'],
      environment: expect.objectContaining({
        METACLAW_IMAGE_BASE_URL: 'http://metaclaw-control:3210/v1',
        METACLAW_IMAGE_API_KEY: 'attempt-token',
        METACLAW_IMAGE_MODEL: 'gpt-image-2',
      }),
      egressMode: 'disabled',
    }));
    expect(JSON.stringify(create.mock.calls[0]![0].environment)).not.toContain('provider-secret');
    expect(close).toHaveBeenCalled();
  });
});

function runtimeBinding(): RuntimePrivateConfigurationBinding {
  return {
    revisionId: 'revision-1',
    bindingFingerprint: 'fingerprint',
    environment: {
      OPENAI_BASE_URL: 'https://provider.example/v1',
      OPENAI_API_KEY: 'provider-secret',
      OPENAI_MODEL: 'gpt-image-2',
    },
  };
}

function authorizedBinding() {
  return {
    agentClassRef: 'pi-research',
    harnessRef: 'pi-cli',
    providerRef: 'code-cli',
    modelRef: 'image-model',
    permissionProfileRef: 'public-web-research',
    configurationRevision: 'revision-1',
  };
}

function executorInput(): ExecutorInput {
  return {
    context: {
      currentSubtask: {
        id: 'subtask-1',
        title: 'Generate image',
        goal: '生成产品图',
        deliveryKind: 'edit',
        requiredCapabilities: ['image-generation'],
        acceptance: [],
      },
    } as never,
    executionBinding: {
      attemptId: 'attempt-1',
      taskId: 'task-1',
      generationId: 'generation-1',
      subtaskId: 'subtask-1',
      workUnitId: 'work-unit-1',
      leaseToken: 'lease',
      idempotencyKey: 'idempotency',
      workspacePath: '/host/workspace',
      workspaceId: 'workspace-1',
      sourcePath: '/host/source',
      inputsPath: '/host/inputs',
      handoffsPath: '/host/handoffs',
      gitMetadataPath: null,
      controlNetwork: 'metaclaw-control',
      capabilityBinding: null,
    },
  };
}

function backendPort(
  create: ReturnType<typeof vi.fn>,
): AttemptExecutionBackend {
  return {
    kind: 'container',
    pathMode: 'container',
    resolveImage: vi.fn(async () => 'sha256:image'),
    create,
    start: vi.fn(async () => undefined),
    wait: vi.fn(async () => 0),
    logs: vi.fn(async () => [
      JSON.stringify({ type: 'status', text: 'started' }),
      JSON.stringify({
        type: 'result',
        success: true,
        output: '图片完成',
        artifactPaths: ['artifacts/images/subtask-1/attempt-1-01.png'],
      }),
    ].join('\n')),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    inspect: vi.fn(async () => null),
    stop: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    listManaged: vi.fn(async () => []),
  };
}
