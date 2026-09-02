import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { COMPLETION_MARKER_V4 } from '../execution/completion-protocol.js';
import { normalizeExecutorFailure } from './error-utils.js';
import {
  loadInputImages,
  mimeTypeExtension,
  type ImageInputLimits,
} from './image-input-loader.js';
import { requestImage } from './image-api-client.js';

const MAX_PROMPT_BYTES = 32 * 1024;

export interface ImageApiRunnerInput {
  operation: 'generation' | 'editing';
  workspacePath: string;
  inputsPath?: string;
  attemptId: string;
  subtaskId: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  prompt: string;
  signal?: AbortSignal;
  inputLimits?: ImageInputLimits;
  onProgress?: (text: string) => void;
}

export type ImageApiRunnerResult =
  | { success: true; output: string; artifactPaths: string[] }
  | { success: false; output: string; error: string };

export async function runImageApi(input: ImageApiRunnerInput): Promise<ImageApiRunnerResult> {
  try {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('image prompt is required');
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw new Error(`image prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
    }
    if (input.operation === 'editing' && !input.inputsPath) {
      throw new Error('image editing requires input images');
    }
    const inputs = await loadInputImages(input.inputsPath, input.inputLimits);
    if (input.operation === 'editing' && inputs.length === 0) {
      throw new Error('image editing requires at least one input image');
    }
    input.onProgress?.(`image ${input.operation} request started`);
    const outputs = await requestImage({
      operation: input.operation,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      modelId: input.modelId,
      prompt,
      inputs,
      signal: input.signal,
    });
    const workspace = resolve(input.workspacePath);
    const outputDirectory = resolve(workspace, 'artifacts', 'images', safeSegment(input.subtaskId));
    if (!isWithin(workspace, outputDirectory)) throw new Error('image output path escapes workspace');
    await mkdir(outputDirectory, { recursive: true });
    const artifactPaths: string[] = [];
    for (const [index, image] of outputs.entries()) {
      const fileName = `${safeSegment(input.attemptId)}-${String(index + 1).padStart(2, '0')}${mimeTypeExtension(image.mimeType)}`;
      const target = resolve(outputDirectory, fileName);
      if (!isWithin(workspace, target)) throw new Error('image output path escapes workspace');
      await writeFile(target, image.bytes, { flag: 'wx' });
      artifactPaths.push(relative(workspace, target).split(sep).join('/'));
    }
    input.onProgress?.(`image ${input.operation} request completed`);
    const output = [
      `图片${input.operation === 'editing' ? '编辑' : '生成'}完成：${artifactPaths.join(', ')}`,
      '',
      COMPLETION_MARKER_V4,
      JSON.stringify({
        evidence: [`已生成并验证 ${artifactPaths.length} 个图片产物：${artifactPaths.join(', ')}`],
        noChangeReason: null,
      }),
    ].join('\n');
    return { success: true, output, artifactPaths };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: '',
      error: normalizeExecutorFailure(message).summary,
    };
  }
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^\.{1,2}$/u, '_');
  return normalized.slice(0, 120) || 'unknown';
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}
