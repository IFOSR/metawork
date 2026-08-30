import { describe, expect, it } from 'vitest';
import {
  buildProviderCompletionCatalog,
  discoverOpenAiCompatibleModels,
} from '../../src/configuration/provider-model-discovery.js';

describe('Provider model discovery', () => {
  it('returns every unique model ID from an OpenAI-compatible data response', async () => {
    const result = await discoverOpenAiCompatibleModels({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      fetchImpl: async () => new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'gpt-5.6-terra', object: 'model' },
          { id: 'gpt-5.4', object: 'model' },
          { id: 'gpt-5.4', object: 'model' },
        ],
      }), { status: 200 }),
    });

    expect(result).toEqual({
      status: 'discovered',
      modelIds: ['gpt-5.4', 'gpt-5.6-terra'],
    });
  });

  it('keeps configured models when live discovery is unavailable', async () => {
    const catalog = await buildProviderCompletionCatalog({
      providers: {
        code: {
          baseUrl: 'https://provider.example/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/code',
        },
      },
      models: {
        configured: { providerRef: 'code', modelId: 'configured-model' },
      },
      readSecret: async () => 'secret',
      fetchImpl: async () => new Response('upstream failure', { status: 503 }),
    });

    expect(catalog).toEqual([{
      providerRef: 'code',
      baseUrl: 'https://provider.example/v1',
      credentialAvailable: true,
      modelIds: ['configured-model'],
    }]);
  });

  it('does not call the Provider when its credential is unavailable', async () => {
    let requests = 0;
    const catalog = await buildProviderCompletionCatalog({
      providers: {
        code: {
          baseUrl: 'https://provider.example/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/code',
        },
      },
      models: {
        configured: { providerRef: 'code', modelId: 'configured-model' },
      },
      readSecret: async () => {
        throw new Error('secret missing');
      },
      fetchImpl: async () => {
        requests += 1;
        return new Response('{}');
      },
    });

    expect(requests).toBe(0);
    expect(catalog[0]).toMatchObject({
      credentialAvailable: false,
      modelIds: ['configured-model'],
    });
  });

  it.each([
    ['malformed JSON', '{not-json', {}],
    ['oversized body', JSON.stringify({ data: [{ id: 'x'.repeat(1_000_001) }] }), {}],
    ['oversized declared response', '{}', { 'content-length': '1000001' }],
  ])('retains configured models for %s', async (_name, body, headers) => {
    const catalog = await buildProviderCompletionCatalog({
      providers: {
        code: {
          baseUrl: 'https://provider.example/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/code',
        },
      },
      models: {
        configured: { providerRef: 'code', modelId: 'configured-model' },
      },
      readSecret: async () => 'highly-sensitive-key',
      fetchImpl: async () => new Response(body, { status: 200, headers }),
    });

    expect(catalog[0]?.modelIds).toEqual(['configured-model']);
    expect(JSON.stringify(catalog)).not.toContain('highly-sensitive-key');
  });

  it('sends the credential only in the upstream Authorization header', async () => {
    let authorization = '';
    const result = await discoverOpenAiCompatibleModels({
      baseUrl: 'https://provider.example/v1/',
      apiKey: 'highly-sensitive-key',
      fetchImpl: async (url, init) => {
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        expect(String(url)).toBe('https://provider.example/v1/models');
        return new Response(JSON.stringify({ models: [{ name: 'provider-model' }] }));
      },
    });

    expect(authorization).toBe('Bearer highly-sensitive-key');
    expect(result).toEqual({ status: 'discovered', modelIds: ['provider-model'] });
    expect(JSON.stringify(result)).not.toContain('highly-sensitive-key');
  });
});
