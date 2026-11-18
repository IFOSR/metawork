import { describe, expect, it } from 'vitest';
import { resolveSummarizationModelFacts } from '../../src/configuration/openrouter-model-catalog.js';

const readyCatalog = {
  status: 'ready' as const,
  fetchedAt: '2026-11-17T00:00:00.000Z',
  models: {
    'openai/gpt-5.5': { modelId: 'openai/gpt-5.5', capabilities: ['tools'] },
  },
};

const unavailableCatalog = { status: 'unavailable' as const, models: {}, error: 'fetch failed' };

describe('能力描述整理的模型事实解析', () => {
  it('目录里精确命中时用目录事实', () => {
    const resolved = resolveSummarizationModelFacts({
      catalog: readyCatalog,
      catalogModelId: 'openai/gpt-5.5',
    });
    expect(resolved.model?.modelId).toBe('openai/gpt-5.5');
    expect(resolved.error).toBeUndefined();
  });

  it('自定义 Provider 的模型不在目录里时，用模型标识兜底（不失败）', () => {
    const resolved = resolveSummarizationModelFacts({
      catalog: readyCatalog,
      catalogModelId: 'glm-5.3-flash',
      preferredModelId: 'glm-5.3-flash',
    });
    expect(resolved.error).toBeUndefined();
    expect(resolved.model?.modelId).toBe('glm-5.3-flash');
    expect(resolved.model?.capabilities).toEqual([]);
  });

  it('目录不可用时同样用模型标识兜底（首次拉取失败不再让流程 500）', () => {
    const resolved = resolveSummarizationModelFacts({
      catalog: unavailableCatalog,
      catalogModelId: 'glm-5.3-flash',
      preferredModelId: 'glm-5.3-flash',
    });
    expect(resolved.error).toBeUndefined();
    expect(resolved.model?.modelId).toBe('glm-5.3-flash');
  });

  it('既没有目录命中也没有用户模型时：区分「目录没就绪」与「目录里没有这个模型」', () => {
    const notReady = resolveSummarizationModelFacts({
      catalog: unavailableCatalog,
      catalogModelId: 'glm-5.3-flash',
    });
    expect(notReady.model).toBeUndefined();
    expect(notReady.error).toContain('目录暂时不可用');
    const missing = resolveSummarizationModelFacts({
      catalog: readyCatalog,
      catalogModelId: 'glm-5.3-flash',
    });
    expect(missing.model).toBeUndefined();
    expect(missing.error).toContain('未找到');
  });
});
