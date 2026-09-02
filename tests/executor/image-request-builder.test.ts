import { describe, expect, it } from 'vitest';
import {
  buildImageRequest,
  type ImageRequestInput,
} from '../../src/executor/image-request-builder.js';

describe('buildImageRequest', () => {
  it('builds a JSON generation request from only image-facing fields', async () => {
    const request = await buildImageRequest({
      operation: 'generation',
      baseUrl: 'https://code-cli.example/v1/',
      apiKey: 'secret',
      modelId: 'gpt-image-2',
      prompt: '生成一张蓝色背景的产品海报',
      inputs: [],
    } satisfies ImageRequestInput);

    expect(request.url).toBe('https://code-cli.example/v1/images/generations');
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toMatchObject({
      authorization: 'Bearer secret',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(request.init.body))).toEqual({
      model: 'gpt-image-2',
      prompt: '生成一张蓝色背景的产品海报',
      n: 1,
      response_format: 'b64_json',
    });
    expect(JSON.stringify(request)).not.toContain('completion');
    expect(JSON.stringify(request)).not.toContain('bindingFingerprint');
  });

  it('builds a multipart edit request containing the authorized input image', async () => {
    const request = await buildImageRequest({
      operation: 'editing',
      baseUrl: 'https://code-cli.example/v1',
      apiKey: 'secret',
      modelId: 'gpt-image-2',
      prompt: '把背景改成蓝色',
      inputs: [{
        name: 'source.png',
        mimeType: 'image/png',
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }],
    } satisfies ImageRequestInput);

    expect(request.url).toBe('https://code-cli.example/v1/images/edits');
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toMatchObject({
      authorization: 'Bearer secret',
    });
    expect(request.init.body).toBeInstanceOf(FormData);
    const form = request.init.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2');
    expect(form.get('prompt')).toBe('把背景改成蓝色');
    expect(form.get('n')).toBe('1');
    expect(form.get('response_format')).toBe('b64_json');
    expect(form.get('image')).toBeInstanceOf(File);
  });
});
