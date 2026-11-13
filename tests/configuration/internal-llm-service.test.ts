import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialsFileSecretStore } from '../../src/configuration/credentials-file-secret-store.js';
import { loadInternalSettingsAssistantConfig } from '../../src/configuration/internal-settings-assistant-config.js';
import { InternalLlmService, PreferredModelError } from '../../src/configuration/internal-llm-service.js';
import { ModelRoutingProfileService } from '../../src/configuration/model-routing-profile-service.js';
import { MODEL_SUMMARY_PROMPT } from '../../src/configuration/model-summary-prompt.js';

describe('preferred user model routing', () => {
  const data = { models: [{ modelRef: 'code-cli' }] };

  it('routes capability explanation through the user model and skips the official service', async () => {
    const officialAi = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }),
      { status: 200 },
    ));
    const service = new InternalLlmService({
      officialAi, fetchImpl,
      preferredModel: async () => ({ baseUrl: 'https://user.example/v1', apiKey: 'user-key', modelId: 'user-model' }),
    });

    await service.generate({ action: '智能体能力整理', operation: 'capability_explanation', data });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(officialAi).not.toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://user.example/v1/chat/completions');
    expect(JSON.parse(String(init!.body)).model).toBe('user-model');
  });

  it('falls back to the official service when the user model call fails', async () => {
    const officialAi = vi.fn(async () => ({ ok: true }));
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const service = new InternalLlmService({
      officialAi, fetchImpl,
      preferredModel: async () => ({ baseUrl: 'https://user.example/v1', apiKey: 'user-key', modelId: 'user-model' }),
    });

    await service.generate({ action: '智能体能力整理', operation: 'capability_explanation', data });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(officialAi).toHaveBeenCalledTimes(1);
  });

  it('keeps the official route when no preferred model resolves', async () => {
    const officialAi = vi.fn(async () => ({ ok: true }));
    const service = new InternalLlmService({ officialAi, preferredModel: async () => null });

    await service.generate({ action: '智能体能力整理', operation: 'capability_explanation', data: {} });

    expect(officialAi).toHaveBeenCalledTimes(1);
  });

  it('surfaces preferred model configuration errors instead of masking them', async () => {
    const officialAi = vi.fn(async () => ({ ok: true }));
    const fetchImpl = vi.fn();
    const service = new InternalLlmService({
      officialAi, fetchImpl,
      preferredModel: async () => {
        throw new PreferredModelError('固定模型缺少可用的 Provider 凭证');
      },
    });

    // 用户指定的模型不可用时改由官方内置 AI 完成本次生成，但原因必须如实
    // 交回界面——不能悄悄换个模型让用户以为结果出自自己的模型。
    const notices: string[] = [];
    await service.generate({
      action: '智能体能力整理', operation: 'capability_explanation', data,
      onDegraded: notice => { notices.push(notice.reason); },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(officialAi).toHaveBeenCalledTimes(1);
    expect(notices).toEqual(['固定模型缺少可用的 Provider 凭证']);
  });

  it('keeps the preferred model error when no official channel can take over', async () => {
    const fetchImpl = vi.fn();
    const service = new InternalLlmService({
      fetchImpl,
      preferredModel: async () => {
        throw new PreferredModelError('用户配置模型尚未保存激活');
      },
    });

    // 没有官方通道可兜底时，原始可操作错误必须保留。
    await expect(service.generate({
      action: '智能体能力整理', operation: 'capability_explanation', data,
    })).rejects.toThrow('用户配置模型尚未保存激活');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits sampling parameters so models that pin temperature stay usable', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }),
      { status: 200 },
    ));
    const service = new InternalLlmService({
      fetchImpl,
      preferredModel: async () => ({ baseUrl: 'https://user.example/v1', apiKey: 'user-key', modelId: 'kimi-for-coding' }),
    });

    await service.generate({ action: '智能体能力整理', operation: 'capability_explanation', data });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.model).toBe('kimi-for-coding');
    expect(body.temperature).toBeUndefined();
  });

  it('summarizes model information through the user-configured model instead of the official service', async () => {
    const officialAi = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        summary: '用于代码实现的模型', strengths: ['编码'], limitations: [],
        preferredTaskTypes: ['回归测试'], avoidTaskTypes: [],
      }) } }] }),
      { status: 200 },
    ));
    const service = new InternalLlmService({
      officialAi, fetchImpl,
      preferredModel: async input => (input.preferredModel
        ? { baseUrl: 'https://user.example/v1', apiKey: 'user-key', modelId: input.preferredModel.modelId }
        : null),
    });
    const profiles = new ModelRoutingProfileService(service);

    const notes = await profiles.summarize(
      {
        modelId: 'moonshotai/kimi-k2-0711', capabilities: ['coding'], description: '公开描述',
        pricing: { source: 'openrouter', exchangeRate: 7 },
      },
      { providerRef: 'custom-model-2', modelId: 'kimi-for-coding' },
    );

    expect(notes.summary).toBe('用于代码实现的模型');
    expect(officialAi).not.toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://user.example/v1/chat/completions');
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe('kimi-for-coding');
    // 直调必须带产出契约提示词：用户自己的模型不会知道 MetaWork 的字段约定。
    expect(body.messages[0].content).toBe(MODEL_SUMMARY_PROMPT);
    // 直调不发采样参数：kimi-for-coding 只接受特定 temperature。
    expect(body.temperature).toBeUndefined();
  });

  it('falls back to the official service when the user-configured model call fails', async () => {
    const officialAi = vi.fn(async () => {
      throw new Error('请先在本机 Web 或 Desktop 登录 MetaWork 官方账号。');
    });
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const service = new InternalLlmService({
      officialAi, fetchImpl,
      preferredModel: async input => (input.preferredModel
        ? { baseUrl: 'https://user.example/v1', apiKey: 'user-key', modelId: input.preferredModel.modelId }
        : null),
    });
    const profiles = new ModelRoutingProfileService(service);

    await expect(profiles.summarize(
      {
        modelId: 'moonshotai/kimi-k2-0711', capabilities: ['coding'],
        pricing: { source: 'openrouter', exchangeRate: 7 },
      },
      { providerRef: 'custom-model-2', modelId: 'kimi-for-coding' },
    )).rejects.toThrow(/官方内置 AI 兜底亦失败/u);
    expect(officialAi).toHaveBeenCalledTimes(1);
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'metawork-internal-llm-'));
  roots.push(root);
  await mkdir(join(root, 'internal'));
  const config = {
    provider: 'deepseek', modelId: 'deepseek-flash', baseUrl: 'https://internal.example/v1',
    apiKeyRef: 'file-secret:anyfusion/internal/llm', enabled: true, timeoutMs: 60_000,
    maxTokens: 4_096, thinking: 'disabled',
  };
  const configPath = join(root, 'internal/llm.json');
  await writeFile(configPath, JSON.stringify(config));
  const account = new CredentialsFileSecretStore(join(root, 'credentials.json'));
  const internal = new CredentialsFileSecretStore(join(root, 'internal/llm-credentials.json'));
  await account.put('file-secret:anyfusion/providers/provider', 'original-key');
  await internal.put('file-secret:anyfusion/internal/llm', await account.get('file-secret:anyfusion/providers/provider'));
  return { root, config, configPath, account, internal };
}

describe('installation-owned internal LLM', () => {
  it('keeps the copied credential independent and reloads developer edits on the next call', async () => {
    const { root, config, configPath, account, internal } = await setup();
    const calls: Array<{ url: string; model: string; key: string }> = [];
    const service = new InternalLlmService({
      config: () => loadInternalSettingsAssistantConfig({ installRoot: root }), secretStore: internal,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), model: JSON.parse(String(init?.body)).model, key: (init?.headers as Record<string, string>).Authorization });
        return Response.json({ choices: [] });
      },
    });
    await account.delete('file-secret:anyfusion/providers/provider');
    await service.generate({ action: 'AI 改写', system: 'rewrite', data: {} });
    await writeFile(configPath, JSON.stringify({ ...config, provider: 'replacement', modelId: 'replacement-model', baseUrl: 'https://replacement.example/v1' }));
    await internal.put('file-secret:anyfusion/internal/llm', 'replacement-key');
    await service.generate({ action: '模型信息提炼', system: 'summarize', data: {} });
    expect(calls).toEqual([
      { url: 'https://internal.example/v1/chat/completions', model: 'deepseek-flash', key: 'Bearer original-key' },
      { url: 'https://replacement.example/v1/chat/completions', model: 'replacement-model', key: 'Bearer replacement-key' },
    ]);
    expect(await readFile(configPath, 'utf8')).not.toContain('replacement-key');
  });

  it('fails closed for malformed config or a Provider credential reference', async () => {
    const { root, config, configPath } = await setup();
    for (const value of ['{"sensitive', JSON.stringify({ ...config, apiKeyRef: 'file-secret:anyfusion/providers/provider' })]) {
      await writeFile(configPath, value);
      await expect(loadInternalSettingsAssistantConfig({ installRoot: root })).rejects.toThrow('内部 LLM 配置无效');
    }
    await rm(configPath);
    expect((await loadInternalSettingsAssistantConfig({ installRoot: root })).enabled).toBe(false);
  });

  it('omits sampling parameters so models that pin temperature stay usable', async () => {
    const { root, internal } = await setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }));
    const service = new InternalLlmService({
      config: () => loadInternalSettingsAssistantConfig({ installRoot: root }), secretStore: internal, fetchImpl,
    });

    await service.generate({ action: 'AI 改写', system: 'rewrite', data: {} });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.model).toBe('deepseek-flash');
    expect(body.temperature).toBeUndefined();
  });

  it('generates task-fit notes without granting hard capabilities or changing public facts', async () => {
    const { root, internal } = await setup();
    const notes = { summary: '适合工程实现与回归测试。', strengths: ['代码分析'], limitations: [], preferredTaskTypes: ['回归测试'], avoidTaskTypes: [] };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(notes) } }] }));
    const service = new ModelRoutingProfileService(new InternalLlmService({
      config: () => loadInternalSettingsAssistantConfig({ installRoot: root }), secretStore: internal, fetchImpl,
    }));
    const model = { modelId: 'public/model', capabilities: [], description: 'Optimized for coding and testing.', pricing: { source: 'openrouter' as const, exchangeRate: 7 as const } };
    expect(await service.summarize(model)).toEqual(notes);
    expect(model.capabilities).toEqual([]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).messages[1].content).toContain(model.description);
  });

  it('rejects fabricated capability fields and truncated generation', async () => {
    const { root, internal } = await setup();
    for (const finish of ['stop', 'length']) {
      const service = new ModelRoutingProfileService(new InternalLlmService({
        config: () => loadInternalSettingsAssistantConfig({ installRoot: root }), secretStore: internal,
        fetchImpl: async () => Response.json({ choices: [{ finish_reason: finish, message: { content: JSON.stringify({ summary: '模型', strengths: [], limitations: [], preferredTaskTypes: [], avoidTaskTypes: [], capabilities: ['image-generation'] }) } }] }),
      }));
      await expect(service.summarize({ modelId: 'public/model', capabilities: [], pricing: { source: 'openrouter', exchangeRate: 7 } }))
        .rejects.toThrow('原能力描述未修改');
    }
  });
});
