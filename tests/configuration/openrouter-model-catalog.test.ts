import { describe, expect, it } from 'vitest';
import {
  OpenRouterModelCatalog,
  matchOpenRouterModel,
  parseOpenRouterCatalog,
  rankOpenRouterModels,
  usdPerTokenToCnyPerMillion,
} from '../../src/configuration/openrouter-model-catalog.js';

describe('OpenRouterModelCatalog', () => {
  it('converts USD per token to CNY per million tokens at the fixed rate', () => {
    expect(usdPerTokenToCnyPerMillion(0.14)).toBe(980_000);
    expect(usdPerTokenToCnyPerMillion(0.28)).toBe(1_960_000);
  });

  it('parses public model facts, pricing and image modalities', () => {
    const result = parseOpenRouterCatalog({ data: [{
      id: 'demo/vision',
      name: 'Demo Vision',
      description: 'A vision model with long context',
      context_length: 128_000,
      architecture: { input_modalities: ['text', 'image'] },
      top_provider: { max_completion_tokens: 16_000 },
      supported_parameters: ['tools', 'structured_outputs'],
      reasoning: { default_enabled: true, supported_efforts: ['low', 'high'] },
      benchmarks: { artificial_analysis: { coding_index: 76.9 } },
      pricing: { prompt: '0.14', completion: '0.28' },
    }] }, '2026-10-04T00:00:00.000Z');
    expect(result.models['demo/vision']).toMatchObject({
      contextLimit: 128_000,
      costInputPerMillion: 980_000,
      costOutputPerMillion: 1_960_000,
      capabilities: expect.arrayContaining(['vision', 'long-context']),
      pricing: {
        source: 'openrouter',
        usdInputPerToken: 0.14,
        usdOutputPerToken: 0.28,
        exchangeRate: 7,
        fetchedAt: '2026-10-04T00:00:00.000Z',
      },
      publicFacts: {
        inputModalities: ['text', 'image'],
        supportedParameters: ['tools', 'structured_outputs'],
        maxCompletionTokens: 16_000,
        benchmarks: { 'artificial_analysis.coding_index': 76.9 },
      },
    });
  });

  it('maps OpenRouter model facts to routing capabilities', () => {
    const result = parseOpenRouterCatalog({ data: [{
      id: 'openai/gpt-6-astra',
      name: 'OpenAI: GPT-6 Astra',
      description: "OpenAI's flagship model for advanced analysis, software engineering, deep research, scientific work, and long-horizon tasks",
      context_length: 1_050_000,
      architecture: { input_modalities: ['text', 'image', 'file'] },
      supported_parameters: ['reasoning', 'reasoning_effort', 'response_format', 'tools'],
      pricing: {},
    }] });
    expect(result.models['openai/gpt-6-astra']?.capabilities).toEqual([
      'coding', 'long-context', 'planning', 'structured-output', 'tools', 'vision',
    ]);
  });

  it('ignores malformed rows and models without pricing remain usable', () => {
    const result = parseOpenRouterCatalog({ data: [null, { id: 'demo/free', pricing: {} }, { name: 'missing id' }] });
    expect(Object.keys(result.models)).toEqual(['demo/free']);
    expect(result.models['demo/free']?.costInputPerMillion).toBeUndefined();
  });

  it('matches a unique public display name without guessing ambiguous entries', () => {
    const snapshot = parseOpenRouterCatalog({ data: [
      { id: 'demo/one', name: 'Friendly Model' },
      { id: 'demo/two', name: 'Other Model' },
    ] });
    expect(matchOpenRouterModel(snapshot, 'Friendly Model')?.modelId).toBe('demo/one');
    expect(matchOpenRouterModel(snapshot, 'missing')).toBeUndefined();
  });

  it('ranks provider-prefixed candidates for local model ids', () => {
    const snapshot = parseOpenRouterCatalog({ data: [
      { id: 'openai/gpt-6-sol', name: 'OpenAI: GPT-6 Sol', pricing: {} },
      { id: 'openai/gpt-6-sol-pro', name: 'OpenAI: GPT-6 Sol Pro', pricing: {} },
      { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: DeepSeek V4.1 Flash', pricing: {} },
    ] });
    expect(matchOpenRouterModel(snapshot, 'gpt-6-sol')?.modelId).toBe('openai/gpt-6-sol');
    expect(rankOpenRouterModels(snapshot, 'deepseek-flash')[0]?.model.modelId)
      .toBe('deepseek/deepseek-v4.1-flash');
    expect(matchOpenRouterModel(snapshot, 'deepseek-flash')).toBeUndefined();
  });

  it('returns the last successful snapshot when a refresh fails', async () => {
    let calls = 0;
    const catalog = new OpenRouterModelCatalog({
      fetchImpl: async () => {
        calls += 1;
        if (calls > 1) throw new Error('offline');
        return new Response(JSON.stringify({ data: [{ id: 'demo/model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      cacheTtlMs: 0,
    });
    const first = await catalog.getSnapshot();
    const second = await catalog.getSnapshot({ forceRefresh: true });
    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
    expect(second.models['demo/model']).toBeDefined();
  });
});
