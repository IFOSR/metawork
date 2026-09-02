import type { ImageInput } from './image-input-loader.js';

export interface ImageRequestInput {
  operation: 'generation' | 'editing';
  baseUrl: string;
  apiKey: string;
  modelId: string;
  prompt: string;
  inputs: readonly ImageInput[];
  signal?: AbortSignal;
}

export interface ImageRequest {
  url: string;
  init: RequestInit;
}

export async function buildImageRequest(input: ImageRequestInput): Promise<ImageRequest> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('image prompt is required');
  if (!input.apiKey.trim()) throw new Error('image provider credential is empty');
  if (!input.modelId.trim()) throw new Error('image model is required');
  const url = `${input.baseUrl.replace(/\/+$/u, '')}/images/${input.operation === 'editing' ? 'edits' : 'generations'}`;
  if (input.operation === 'generation') {
    return {
      url,
      init: {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: input.modelId,
          prompt,
          n: 1,
          response_format: 'b64_json',
        }),
        signal: input.signal,
      },
    };
  }
  if (input.inputs.length === 0) {
    throw new Error('image editing requires at least one input image');
  }
  const form = new FormData();
  form.set('model', input.modelId);
  form.set('prompt', prompt);
  form.set('n', '1');
  form.set('response_format', 'b64_json');
  for (const image of input.inputs) {
    form.append(
      'image',
      new File([Uint8Array.from(image.bytes)], image.name, { type: image.mimeType }),
    );
  }
  return {
    url,
    init: {
      method: 'POST',
      headers: { authorization: `Bearer ${input.apiKey}` },
      body: form,
      signal: input.signal,
    },
  };
}
