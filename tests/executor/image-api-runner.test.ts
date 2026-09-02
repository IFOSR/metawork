import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPLETION_MARKER_V4 } from '../../src/execution/completion-protocol.js';
import {
  runImageApi,
  type ImageApiRunnerInput,
} from '../../src/executor/image-api-runner.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe('runImageApi', () => {
  it('writes a verified image artifact and emits a completion report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-image-runner-'));
    roots.push(root);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUg==' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const result = await runImageApi({
      operation: 'generation',
      workspacePath: root,
      inputsPath: join(root, 'inputs'),
      attemptId: 'attempt-1',
      subtaskId: 'subtask-1',
      baseUrl: 'https://code-cli.example/v1',
      apiKey: 'secret',
      modelId: 'gpt-image-2',
      prompt: '生成一张产品海报',
    } satisfies ImageApiRunnerInput);

    expect(result.success).toBe(true);
    expect(result.output).toContain(COMPLETION_MARKER_V4);
    expect(result.output).not.toContain('secret');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://code-cli.example/v1/images/generations',
      expect.any(Object),
    );
    const artifact = join(root, 'artifacts', 'images', 'subtask-1', 'attempt-1-01.png');
    await expect(readFile(artifact)).resolves.toEqual(
      Buffer.from('iVBORw0KGgoAAAANSUhEUg==', 'base64'),
    );
  });

  it('fails without creating a fake completion when the provider returns an invalid image', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-image-runner-invalid-'));
    roots.push(root);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ data: [{ b64_json: 'not-an-image' }] }),
      { status: 200 },
    ));

    const result = await runImageApi({
      operation: 'generation',
      workspacePath: root,
      inputsPath: join(root, 'inputs'),
      attemptId: 'attempt-2',
      subtaskId: 'subtask-2',
      baseUrl: 'https://code-cli.example/v1',
      apiKey: 'secret',
      modelId: 'gpt-image-2',
      prompt: '生成图片',
    } satisfies ImageApiRunnerInput);

    expect(result.success).toBe(false);
    expect(result.output).not.toContain(COMPLETION_MARKER_V4);
    expect(result.error).toMatch(/valid image|signature/i);
  });
});
