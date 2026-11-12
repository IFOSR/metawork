import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreferredModelError } from '../../src/configuration/internal-llm-service.js';
import { resolvePreferredModel } from '../../src/configuration/preferred-model-resolver.js';

const credentials = new Map<string, string>([
  ['file-secret:anyfusion/providers/custom-model-2', 'kimi-key'],
]);
const readCredential = vi.fn(async (reference: string) => credentials.get(reference) ?? null);

afterEach(() => { vi.restoreAllMocks(); });

describe('preferred model resolution', () => {
  it('reports the branch it took without logging endpoints or credentials', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await resolvePreferredModel({
      reference: { providerRef: 'custom-model-2', modelId: 'kimi-for-coding' },
      providers: {
        'custom-model-2': {
          baseUrl: 'https://api.kimi.com/coding/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/custom-model-2',
          protocol: 'openai-compatible',
          enabled: true,
        },
      },
      readCredential,
    });

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('active');
    expect(logged).toContain('custom-model-2');
    expect(logged).not.toContain('kimi-key');
    expect(logged).not.toContain('api.kimi.com');
  });
  it('uses the activated Provider endpoint and credential', async () => {
    const transport = await resolvePreferredModel({
      reference: { providerRef: 'custom-model-2', modelId: 'kimi-for-coding' },
      providers: {
        'custom-model-2': {
          baseUrl: 'https://api.kimi.com/coding/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/custom-model-2',
          protocol: 'openai-compatible',
          enabled: true,
        },
      },
      readCredential,
    });

    expect(transport).toEqual({
      baseUrl: 'https://api.kimi.com/coding/v1', apiKey: 'kimi-key', modelId: 'kimi-for-coding',
    });
  });

  it('reports a missing credential instead of silently falling back', async () => {
    await expect(resolvePreferredModel({
      reference: { providerRef: 'custom-model-2', modelId: 'kimi-for-coding' },
      providers: {
        'custom-model-2': {
          baseUrl: 'https://api.kimi.com/coding/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/other',
          protocol: 'openai-compatible',
          enabled: true,
        },
      },
      readCredential,
    })).rejects.toThrow(PreferredModelError);
  });

  it('accepts a public preset endpoint for a Provider that is not activated yet', async () => {
    const transport = await resolvePreferredModel({
      reference: {
        providerRef: 'custom-model-2', modelId: 'kimi-for-coding',
        baseUrl: 'https://api.kimi.com/coding/v1/',
      },
      providers: {},
      readCredential,
    });

    expect(transport.baseUrl).toBe('https://api.kimi.com/coding/v1');
    expect(transport.apiKey).toBe('kimi-key');
  });

  it('refuses an endpoint that is neither activated nor a public preset', async () => {
    await expect(resolvePreferredModel({
      reference: {
        providerRef: 'custom-model-2', modelId: 'kimi-for-coding',
        baseUrl: 'https://proxy.internal.example/v1',
      },
      providers: {},
      readCredential,
    })).rejects.toThrow(/不是官方公开预设/u);
  });

  it('reports a missing preset credential instead of silently falling back', async () => {
    await expect(resolvePreferredModel({
      reference: {
        providerRef: 'custom-model-9', modelId: 'kimi-for-coding',
        baseUrl: 'https://api.kimi.com/coding/v1',
      },
      providers: {},
      readCredential,
    })).rejects.toThrow(/Kimi 的 API Key 尚未保存/u);
  });

  it('points at activation instead of blaming a missing credential', async () => {
    // 用户填了 API Key 但没点保存：密钥根本没进凭据库。错误必须指向
    // "尚未保存激活"，而不是让用户以为 Key 没填、反复重填。
    await expect(resolvePreferredModel({
      reference: {
        providerRef: 'custom-model-3', modelId: 'kimi-for-coding',
        baseUrl: 'https://proxy.internal.example/v1',
      },
      providers: {},
      readCredential,
    })).rejects.toThrow(/尚未保存激活/u);
  });
});
