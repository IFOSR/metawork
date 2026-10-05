import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialsFileSecretStore } from '../../src/configuration/credentials-file-secret-store.js';
import { loadInternalSettingsAssistantConfig } from '../../src/configuration/internal-settings-assistant-config.js';
import { InternalLlmService } from '../../src/configuration/internal-llm-service.js';
import { ModelRoutingProfileService } from '../../src/configuration/model-routing-profile-service.js';

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
