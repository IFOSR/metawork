import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../web/src/api/http.js';

describe('model information transport', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends only the user model reference and never credentials', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({
        catalogModelId: 'moonshotai/kimi-k2-0711', routingNotes: { summary: '代码实现' },
      }), { status: 200 });
    }));

    await new HttpClient().summarizeModelInformation('moonshotai/kimi-k2-0711', {
      providerRef: 'custom-model-2',
      modelId: 'kimi-for-coding',
      baseUrl: 'https://api.kimi.com/coding/v1',
    });

    expect(calls[0]?.url).toBe('/api/config/model-routing-profile');
    expect(calls[0]?.body).toEqual({
      catalogModelId: 'moonshotai/kimi-k2-0711',
      providerRef: 'custom-model-2',
      modelId: 'kimi-for-coding',
      baseUrl: 'https://api.kimi.com/coding/v1',
    });
    // 凭证只能由本机 Server 从凭据库解析，客户端不得携带。
    expect(JSON.stringify(calls[0]?.body)).not.toMatch(/apiKey|token|secret/iu);
  });

  it('omits the preferred model entirely when no user model is selected', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({
        catalogModelId: 'moonshotai/kimi-k2-0711', routingNotes: { summary: '代码实现' },
      }), { status: 200 });
    }));

    await new HttpClient().summarizeModelInformation('moonshotai/kimi-k2-0711');

    expect(calls[0]?.body).toEqual({ catalogModelId: 'moonshotai/kimi-k2-0711' });
  });
});
