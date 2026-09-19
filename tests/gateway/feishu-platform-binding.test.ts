import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnyFusionConfigurationV2Schema } from '../../src/configuration/schema.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { ConfigurationService } from '../../src/configuration/configuration-service.js';
import { withFeishuGatewayEnabled } from '../../src/gateway/feishu-activation.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

// The repository writes immutable revisions; make the tree writable before cleanup.
async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const child of await readdir(path)) {
      await makeWritable(join(path, child));
    }
  } else if (!info.isSymbolicLink()) {
    await chmod(path, 0o600);
  }
}

function configuration() {
  return AnyFusionConfigurationV2Schema.parse({
    schemaVersion: 2,
    providers: {},
    models: {},
    harnesses: {},
    agentClasses: {},
    permissionProfiles: {},
    runtimePolicy: {},
    gateway: {
      platforms: {
        feishu: {
          enabled: true,
          domain: 'feishu',
          connection_mode: 'websocket',
          app_id: 'cli_test',
          app_secret_env: 'FEISHU_APP_SECRET',
        },
      },
    },
  });
}

describe('Feishu platform bind/unbind', () => {
  it('flips enabled while preserving credentials and the rest of the definition', () => {
    const unbound = withFeishuGatewayEnabled(configuration(), false);
    const feishu = unbound.gateway.platforms!.feishu!;
    expect(feishu.enabled).toBe(false);
    expect(feishu.app_id).toBe('cli_test');
    expect(feishu.app_secret_env).toBe('FEISHU_APP_SECRET');
    expect(feishu.connection_mode).toBe('websocket');
    // 原对象不被修改
    expect(configuration().gateway.platforms!.feishu!.enabled).toBe(true);
  });

  it('rejects bind/unbind when this machine has no Feishu platform definition', () => {
    const bare = configuration();
    delete bare.gateway.platforms;
    expect(() => withFeishuGatewayEnabled(bare, false))
      .toThrow(/setup-feishu/);
  });

  it('activates the unbound revision through ConfigurationService', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-binding-'));
    roots.push(root);
    const service = new ConfigurationService({
      repository: new FileConfigurationRepository(join(root, 'config')),
      probe: async () => ({ ok: true }),
    });
    await service.initialize();
    const initial = service.createDraft(configuration(), null);
    service.validateDraft(initial.revisionId);
    service.compileDraft(initial.revisionId);
    await service.probeDraft(initial.revisionId);
    await service.activateDraft(initial.revisionId, null);

    const candidate = withFeishuGatewayEnabled(
      structuredClone((await service.getActiveSnapshot()).config), false,
    );
    const draft = service.createDraft(candidate, initial.revisionId);
    expect(service.validateDraft(draft.revisionId).ok).toBe(true);
    service.compileDraft(draft.revisionId);
    await service.probeDraft(draft.revisionId);
    const activated = await service.activateDraft(draft.revisionId, initial.revisionId);
    expect(activated.ok).toBe(true);
    const active = await service.getActiveSnapshot();
    expect(active.config.gateway.platforms!.feishu!.enabled).toBe(false);
  });
});
