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
  it('seeds and activates a minimal configuration on an empty volume', async () => {
    const { repository, service } = await serviceFixture();
    expect((await repository.recover()).status).toBe('empty');

    const result = await bootstrapContainerConfiguration(service, {
      baseUrl: 'https://api.placeholder.example/v1',
      modelId: 'placeholder-model',
    });
    expect(result.revisionId).toMatch(/^bootstrap-/u);

    const snapshot = await repository.getActiveSnapshot();
    expect(snapshot.revisionId).toBe(result.revisionId);
    expect(snapshot.config.schemaVersion).toBe(2);
    // 校验规则要求 modelRef 指向存在且启用的模型：种子带占位 Provider + 启用模型，
    // 用户随后在设置页换成真实 Provider 与模型。
    const provider = snapshot.config.providers['default-provider'];
    expect(provider?.enabled).toBe(true);
    expect(provider?.baseUrl).toBe('https://api.placeholder.example/v1');
    const model = snapshot.config.models['default-model'];
    expect(model?.enabled).toBe(true);
    expect(model?.modelId).toBe('placeholder-model');
    expect(Object.keys(snapshot.config.agentClasses).sort()).toEqual([
      'codex-engineering', 'pi-research', 'planner',
    ]);
  });

  it('seed shape matches the install-cli configured-provider skeleton', () => {
    const seed = containerSeedConfiguration({ baseUrl: 'https://x.example/v1', modelId: 'm' });
    expect(Object.keys(seed.harnesses).sort()).toEqual([
      'anyfusion-planner', 'codex-cli', 'pi-cli',
    ]);
    expect(seed.agentClasses.planner.harnessRef).toBe('anyfusion-planner');
    expect(seed.permissionProfiles['workspace-engineering']).toBeTruthy();
    expect(seed.permissionProfiles['public-web-research']).toBeTruthy();
    // 占位 Provider/Model 标记 systemManaged：启动自愈只补写这类凭据，
    // 且设置页能把它们与用户自己配置的 Provider 区分开。
    expect(seed.providers['default-provider']?.systemManaged).toBe(true);
    expect(seed.models['default-model']?.systemManaged).toBe(true);
  });

  it('self-heals the placeholder credential when it is missing', async () => {
    const seed = containerSeedConfiguration({});
    const stored = new Map<string, string>();
    const secretStore = {
      get: async (reference: string) => {
        const value = stored.get(reference);
        if (value === undefined) throw new Error('missing');
        return value;
      },
      put: async (reference: string, value: string) => { stored.set(reference, value); },
    };
    const healed = await ensureBootstrapProviderCredentials({ config: seed, secretStore });
    expect(healed).toEqual(['default-provider']);
    expect(stored.get(seed.providers['default-provider']!.apiKeyRef))
      .toBe(BOOTSTRAP_PLACEHOLDER_CREDENTIAL);
  });

  it('heals seeded volumes whose providers predate the systemManaged marker', async () => {
    // 旧种子播种的 Provider 没有 systemManaged 标记：按标记圈范围会让存量卷
    // 永远修不好，判定必须是"enabled 且凭据缺失"。
    const seed = containerSeedConfiguration({});
    delete (seed.providers['default-provider'] as Record<string, unknown>).systemManaged;
    delete (seed.models['default-model'] as Record<string, unknown>).systemManaged;
    const stored = new Map<string, string>();
    const secretStore = {
      get: async () => { throw new Error('missing'); },
      put: async (reference: string, value: string) => { stored.set(reference, value); },
    };
    const healed = await ensureBootstrapProviderCredentials({ config: seed, secretStore });
    expect(healed).toEqual(['default-provider']);
    expect(stored.get(seed.providers['default-provider']!.apiKeyRef))
      .toBe(BOOTSTRAP_PLACEHOLDER_CREDENTIAL);
  });

  it('leaves an existing non-empty credential alone', async () => {
    const seed = containerSeedConfiguration({});
    let puts = 0;
    const secretStore = {
      get: async () => 'sk-user-configured-key',
      put: async () => { puts += 1; },
    };
    const healed = await ensureBootstrapProviderCredentials({ config: seed, secretStore });
    expect(healed).toEqual([]);
    expect(puts).toBe(0);
  });
});
