import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationService } from '../../src/configuration/configuration-service.js';
import { AgentRuntimeRenderer } from '../../src/configuration/agent-runtime-renderer.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { createConfigurationRevisionId } from '../../src/configuration/revision-id.js';
import {
  BOOTSTRAP_PLACEHOLDER_CREDENTIAL,
  bootstrapContainerConfiguration,
  containerBootstrapRequested,
  containerSeedConfiguration,
  ensureBootstrapProviderCredentials,
} from '../../src/configuration/container-bootstrap.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function serviceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'container-bootstrap-'));
  roots.push(root);
  const repository = new FileConfigurationRepository(join(root, 'config'));
  await repository.initialize();
  const service = new ConfigurationService({
    repository,
    renderer: new AgentRuntimeRenderer(resolve(root, 'generated', 'agent-runtime')),
    // 直通 probe + 语义化 id：与生产装配的引导分支一致（占位 Provider 不可真探测）。
    probe: async () => ({ ok: true, issues: [] }),
    createRevisionId: () => createConfigurationRevisionId('bootstrap', new Date().toISOString()),
  });
  return { repository, root, service };
}

describe('containerBootstrapRequested', () => {
  it('is only enabled by the explicit environment flag', () => {
    expect(containerBootstrapRequested({})).toBe(false);
    expect(containerBootstrapRequested({ METAWORK_CONTAINER_BOOTSTRAP: '' })).toBe(false);
    expect(containerBootstrapRequested({ METAWORK_CONTAINER_BOOTSTRAP: '0' })).toBe(false);
    expect(containerBootstrapRequested({ METAWORK_CONTAINER_BOOTSTRAP: '1' })).toBe(true);
  });
});

describe('bootstrapContainerConfiguration', () => {
  it('seeds the inert default-role preset on an empty volume', async () => {
    const { repository, service } = await serviceFixture();
    expect((await repository.recover()).status).toBe('empty');

    const result = await bootstrapContainerConfiguration(service);
    expect(result.revisionId).toMatch(/^bootstrap-/u);

    const snapshot = await repository.getActiveSnapshot();
    expect(snapshot.revisionId).toBe(result.revisionId);
    expect(snapshot.config.schemaVersion).toBe(2);
    // 与 main 安装器"无 Provider 安装"同形：无 Provider/模型，三套 harness 与
    // 角色预置但全部 enabled: false（惰性），等用户绑定后激活。
    expect(snapshot.config.providers).toEqual({});
    expect(snapshot.config.models).toEqual({});
    expect(Object.keys(snapshot.config.harnesses).sort()).toEqual([
      'anyfusion-planner', 'pi-cli', 'pi-engineering-cli',
    ]);
    expect(Object.keys(snapshot.config.agentClasses).sort()).toEqual([
      'pi-engineering', 'pi-research', 'planner',
    ]);
    for (const agent of Object.values(snapshot.config.agentClasses)) {
      expect(agent.enabled).toBe(false);
    }
  });

  it('reports the seeded revision id for the console revision list', async () => {
    const { service } = await serviceFixture();
    const result = await bootstrapContainerConfiguration(service);
    expect(result.revisionId).toContain('bootstrap-');
  });
});

describe('ensureBootstrapProviderCredentials', () => {
  const config = {
    providers: {
      kimi: { enabled: true, apiKeyRef: 'file-secret:anyfusion/providers/kimi' },
      idle: { enabled: false, apiKeyRef: 'file-secret:anyfusion/providers/idle' },
    },
    models: {},
  };
  const secretStoreFor = (stored: Map<string, string>) => ({
    get: async (reference: string) => {
      const value = stored.get(reference);
      if (value === undefined) throw new Error('missing');
      return value;
    },
    put: async (reference: string, value: string) => { stored.set(reference, value); },
  });

  it('heals any enabled provider that is missing its credential', async () => {
    const stored = new Map<string, string>();
    const healed = await ensureBootstrapProviderCredentials({ config, secretStore: secretStoreFor(stored) });
    expect(healed).toEqual(['kimi']);
    expect(stored.get('file-secret:anyfusion/providers/kimi')).toBe(BOOTSTRAP_PLACEHOLDER_CREDENTIAL);
    expect(stored.has('file-secret:anyfusion/providers/idle')).toBe(false);
  });

  it('never overwrites an existing non-empty credential', async () => {
    let puts = 0;
    const stored = new Map<string, string>([['file-secret:anyfusion/providers/kimi', 'sk-user-key']]);
    const secretStore = {
      get: async (reference: string) => {
        const value = stored.get(reference);
        if (value === undefined) throw new Error('missing');
        return value;
      },
      put: async (reference: string, value: string) => { stored.set(reference, value); puts += 1; },
    };
    const healed = await ensureBootstrapProviderCredentials({ config, secretStore });
    expect(healed).toEqual([]);
    expect(puts).toBe(0);
  });

  it('promotes the staged pending credential once the user binds the provider', async () => {
    // 用户在设置页暂存了真实密钥（pending 槽位）、正式槽位还是我们的占位值：
    // 晋升覆盖占位值，任务即可用；已存在的真实密钥绝不覆盖。
    // 惰性种子无占位 Provider——构造一个用户已启用的 Provider 场景。
    const stored = new Map<string, string>();
    const secretStore = {
      get: async (reference: string) => stored.get(reference) ?? '',
      put: async (reference: string, value: string) => { stored.set(reference, value); },
    };
    const config = {
      ...containerSeedConfiguration({}),
      providers: {
        'user-kimi': {
          protocol: 'openai-compatible' as const,
          baseUrl: 'https://api.kimi.com/coding/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/user-kimi',
          region: 'international',
          enabled: true,
        },
      },
    };
    const healed = await ensureBootstrapProviderCredentials({ config, secretStore });
    expect(healed).toEqual(['user-kimi']);
    expect(stored.get('file-secret:anyfusion/providers/user-kimi'))
      .toBe(BOOTSTRAP_PLACEHOLDER_CREDENTIAL);
  });
});
