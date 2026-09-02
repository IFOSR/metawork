import { describe, expect, it, vi } from 'vitest';
import { ImageApiCliDriver } from '../../src/executor/image-api-cli-driver.js';

describe('ImageApiCliDriver', () => {
  it('runs the MetaWork image runner with bounded JSONL output and authorized environment', async () => {
    const processRunner = {
      run: vi.fn(async input => {
        input.onLine?.(JSON.stringify({ type: 'status', text: 'image generation started' }), 'stdout');
        input.onLine?.(JSON.stringify({
          type: 'result',
          success: true,
          output: '图片完成',
          artifactPaths: ['artifacts/images/subtask-1/attempt-1-01.png'],
        }), 'stdout');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
      abort: vi.fn(),
    };
    const driver = new ImageApiCliDriver({
      command: { command: 'node', args: ['/runner.js'] },
      processRunner,
      idleTimeoutMs: 10_000,
    });

    const result = await driver.run({
      operation: 'generation',
      workspacePath: '/workspace/attempt-1',
      inputsPath: '/inputs',
      attemptId: 'attempt-1',
      subtaskId: 'subtask-1',
      baseUrl: 'https://code-cli.example/v1',
      apiKey: 'secret',
      modelId: 'gpt-image-2',
      prompt: '生成产品图',
      onProgress: vi.fn(),
    });

    expect(result).toMatchObject({
      success: true,
      output: '图片完成',
      artifactPaths: ['artifacts/images/subtask-1/attempt-1-01.png'],
    });
    expect(processRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      command: 'node',
      args: ['/runner.js'],
      cwd: '/workspace/attempt-1',
      environment: expect.objectContaining({
        METACLAW_IMAGE_OPERATION: 'generation',
        METACLAW_IMAGE_PROMPT: '生成产品图',
        METACLAW_IMAGE_MODEL: 'gpt-image-2',
        METACLAW_IMAGE_BASE_URL: 'https://code-cli.example/v1',
        METACLAW_IMAGE_API_KEY: 'secret',
        METACLAW_INPUTS_PATH: '/inputs',
      }),
    }));
    expect(processRunner.run.mock.calls[0]![0].environment).not.toHaveProperty('METACLAW_COMPLETION_MARKER');
  });
});
