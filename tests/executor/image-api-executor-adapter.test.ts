import { describe, expect, it, vi } from 'vitest';
import type { ExecutorInput } from '../../src/executor/adapter.js';
import {
  ImageApiExecutorAdapter,
  type ImageApiRunner,
} from '../../src/executor/image-api-executor-adapter.js';

describe('ImageApiExecutorAdapter', () => {
  it('passes a clean image prompt and authorized provider environment to the runner', async () => {
    const run = vi.fn<ImageApiRunner>(async input => ({
      success: true,
      output: 'image completed',
      artifactPaths: ['artifacts/images/subtask-1/attempt-1-01.png'],
    }));
    const adapter = new ImageApiExecutorAdapter({
      agentClassId: 'pi-research',
      authorizedBinding: {
        agentClassRef: 'pi-research',
        harnessRef: 'pi-cli',
        providerRef: 'code-cli',
        modelRef: 'image-model-ref',
        permissionProfileRef: 'public-web-research',
        configurationRevision: 'revision-1',
      },
      runtimeBinding: {
        revisionId: 'revision-1',
        bindingFingerprint: 'fingerprint',
        environment: {
          OPENAI_BASE_URL: 'https://code-cli.example/v1',
          OPENAI_API_KEY: 'secret',
          OPENAI_MODEL: 'gpt-image-2',
        },
      },
      runner: { run },
    });

    const result = await adapter.execute(input(['image-generation']));

    expect(result).toMatchObject({ success: true, output: 'image completed' });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'generation',
      baseUrl: 'https://code-cli.example/v1',
      apiKey: 'secret',
      modelId: 'gpt-image-2',
      workspacePath: '/workspace/attempt-1',
      attemptId: 'attempt-1',
      subtaskId: 'subtask-1',
      prompt: expect.stringContaining('do the task'),
    }));
    expect(run.mock.calls[0]![0].prompt).toContain('操作类型：图片生成');
    expect(run.mock.calls[0]![0].prompt).not.toContain('fingerprint');
    expect(run.mock.calls[0]![0].prompt).not.toContain('completion:v4');
  });
});

function input(requiredCapabilities: string[]): ExecutorInput {
  return {
    context: {
      currentSubtask: {
        id: 'subtask-1',
        title: 'image task',
        goal: 'do the task',
        deliveryKind: 'edit',
        requiredCapabilities,
        acceptance: [{ key: 'image_exists', description: 'an image exists', requiredEvidence: [] }],
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
      workspacePath: '/workspace/attempt-1',
      workspaceId: 'workspace-1',
      sourcePath: '/source',
      inputsPath: '/inputs',
      handoffsPath: '/handoffs',
      gitMetadataPath: null,
      controlNetwork: 'none',
      capabilityBinding: null,
    },
  };
}
