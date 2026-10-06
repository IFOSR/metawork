import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INTERNAL_SETTINGS_ASSISTANT_CONFIG,
  parseInternalSettingsAssistantConfig,
} from '../../src/configuration/internal-settings-assistant-config.js';
import { SettingsAssistant } from '../../src/configuration/settings-assistant.js';
import type { SecretStore } from '../../src/configuration/secret-store.js';

const secretStore: SecretStore = {
  get: async () => 'test-key',
  put: async () => undefined,
  delete: async () => undefined,
};
const sourceText = '擅长代码撰写、项目测试';
const input = {
  agentClassRef: 'executor', sourceText,
  modelFacts: [{
    modelRef: 'm1', modelId: 'glm-flash', capabilities: ['coding', 'tools'],
    description: 'GLM-5.3-Flash is a native multimodal model from Z.ai. It is suited for efficient coding and long-horizon agent tasks.',
  }],
};
// A provider fixture, not an expected deterministic rewrite of arbitrary input.
const generated = {
  mission: '根据项目需求实现代码并开展项目测试，交付经过验证的软件修改。',
  tasks: ['实现功能、修复缺陷，分析修改对关联模块的影响。', '设计正常、异常和边界场景测试，定位失败原因并进行回归验证。'],
  deliverables: ['代码修改、测试用例及测试执行结果。'],
  quality: ['区分已通过、失败和未执行的测试，说明验证范围与遗留风险。'],
  boundaries: ['聚焦代码与测试，不擅自扩大需求范围或执行未经授权的部署。'],
};
function completion(value: unknown, finishReason = 'stop'): Response {
  return Response.json({ choices: [{ finish_reason: finishReason, message: {
    content: typeof value === 'string' ? value : JSON.stringify(value),
  } }] });
}
function assistant(fetchImpl: typeof fetch) {
  return new SettingsAssistant({ config: DEFAULT_INTERNAL_SETTINGS_ASSISTANT_CONFIG, secretStore, fetchImpl });
}

describe('SettingsAssistant', () => {
  it('keeps developer-owned model defaults and a generation-sized timeout', () => {
    expect(parseInternalSettingsAssistantConfig({ modelId: '', apiKeyRef: 'file-secret:bad key' }))
      .toEqual(DEFAULT_INTERNAL_SETTINGS_ASSISTANT_CONFIG);
    expect(DEFAULT_INTERNAL_SETTINGS_ASSISTANT_CONFIG.timeoutMs).toBe(30_000);
  });

  it('requires a real LLM response and never pastes model descriptions into the rewrite', async () => {
    let body = '';
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      body = String(init?.body);
      return completion(generated);
    });
    const result = await assistant(fetchImpl).suggestAgentResponsibility(input);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.sourceText).toBe(sourceText);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.suggestedText).toContain(generated.mission);
    expect(result.suggestedText).toContain(generated.tasks[1]);
    expect(result.suggestedText).not.toContain('GLM');
    expect(result.suggestedText).not.toContain('模型适配提示');
    expect(body).toContain(input.modelFacts[0]!.description);
    expect(body).toContain(sourceText);
    expect(body).not.toContain('test-key');
    expect(JSON.parse(body).model).toBe('deepseek-flash');
  });

  it('rewrites already structured input without nesting or accumulating headings', async () => {
    const first = await assistant(async () => completion(generated)).suggestAgentResponsibility(input);
    const second = await assistant(async () => completion({
      ...generated, mission: `核心职责：核心职责：${generated.mission}`,
    })).suggestAgentResponsibility({ ...input, sourceText: first.suggestedText });
    expect(second.suggestedText).toBe(first.suggestedText);
    expect(second.sourceText).toBe(first.suggestedText);
    expect(second.suggestedText.match(/核心职责：/gu)).toHaveLength(1);
  });

  it('formats provider-generated content for a different domain without injecting coding duties', async () => {
    const research = {
      mission: '为行业研究核验资料并整理有来源支撑的结论。',
      tasks: ['比较不同资料中的结论，标记分歧及其依据。'],
      deliverables: ['研究摘要与来源清单。'],
      quality: ['区分事实、观点和不确定信息。'],
      boundaries: ['不把未经证实的推测当作事实。'],
    };
    const result = await assistant(async () => completion(research)).suggestAgentResponsibility({
      ...input, sourceText: '行业资料研究',
    });
    expect(result.suggestedText).toContain(research.mission);
    expect(result.suggestedText).not.toContain('代码');
  });

  it('reports a missing credential instead of returning a fabricated success', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = new SettingsAssistant({
      config: DEFAULT_INTERNAL_SETTINGS_ASSISTANT_CONFIG,
      secretStore: { ...secretStore, get: async () => { throw new Error('private secret ref'); } },
      fetchImpl,
    });
    await expect(service.suggestAgentResponsibility(input)).rejects.toThrow('凭证不可用');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(input.sourceText).toBe(sourceText);
  });

  it('reports a disabled service without making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = new SettingsAssistant({
      config: { ...DEFAULT_INTERNAL_SETTINGS_ASSISTANT_CONFIG, enabled: false }, secretStore, fetchImpl,
    });
    await expect(service.suggestAgentResponsibility(input)).rejects.toThrow('未启用');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([401, 429, 500])('reports HTTP %i without exposing the provider response', async status => {
    await expect(assistant(async () => new Response('private provider diagnostics', { status }))
      .suggestAgentResponsibility(input)).rejects.toThrow(`请求失败（HTTP ${status}），原内容未修改`);
  });

  it.each([
    ['malformed JSON', 'not JSON'],
    ['missing fields', { mission: '代码与测试' }],
    ['empty field', { ...generated, tasks: [] }],
    ['catalog copy', { ...generated, tasks: [input.modelFacts[0]!.description] }],
    ['mixed catalog copy', { ...generated, tasks: [`适合任务：${input.modelFacts[0]!.description}`] }],
    ['nested old document', { ...generated, mission: `核心职责：代码。\n主要任务：测试。` }],
    ['oversized result', { ...generated, tasks: Array.from({ length: 5 }, (_, index) => `${index}${'代码测试'.repeat(120)}`) }],
  ])('rejects %s instead of generating a fallback', async (_label, response) => {
    await expect(assistant(async () => completion(response)).suggestAgentResponsibility(input))
      .rejects.toThrow('内容不完整或格式不符合要求');
  });

  it('rejects a truncated response even if the content happens to parse', async () => {
    await expect(assistant(async () => completion(generated, 'length')).suggestAgentResponsibility(input))
      .rejects.toThrow('原文未修改');
  });

  it('sanitizes network errors and reports timeouts separately', async () => {
    await expect(assistant(async () => { throw new Error('Authorization: test-key'); })
      .suggestAgentResponsibility(input)).rejects.toThrow('服务暂时无法连接或响应异常');
    vi.useFakeTimers();
    try {
      const service = assistant(async (_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
      const pending = expect(service.suggestAgentResponsibility(input)).rejects.toThrow('改写超时');
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});
