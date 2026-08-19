import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../../src/account/account-id.js';
import { resolveAccountPaths } from '../../src/account/account-paths.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { FileSecretStore } from '../../src/configuration/file-secret-store.js';
import { prepareSmokeConfiguration } from '../../src/configuration/smoke-configuration.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => removeTree(root)));
});

describe('prepareSmokeConfiguration', () => {
  it('builds one schema-v2 revision from distinct Planner and Executor providers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-smoke-configuration-'));
    roots.push(root);
    const installRoot = join(root, 'install');
    const configHome = join(root, 'native-config');
    await mkdir(join(configHome, 'planner'), { recursive: true });
    await mkdir(join(configHome, 'codex'), { recursive: true });
    await mkdir(join(configHome, 'pi-home', '.pi', 'agent'), { recursive: true });
    await writeFile(join(configHome, 'provider.env'), [
      'OPENAI_BASE_URL=https://api.deepseek.example/v1',
      'OPENAI_API_KEY=deepseek-secret',
      '',
    ].join('\n'));
    await writeFile(join(configHome, 'planner', 'models.json'), JSON.stringify({
      providers: {
        kimi: {
          baseUrl: 'https://api.kimi.example/coding/v1',
          apiKey: 'kimi-secret',
          models: [{ id: 'k3', reasoning: true }],
        },
      },
    }));
    await writeFile(join(configHome, 'planner', 'settings.json'), JSON.stringify({
      defaultProvider: 'kimi',
      defaultModel: 'k3',
    }));
    await writeFile(join(configHome, 'codex', 'config.toml'), [
      'model = "deepseek-v4-pro"',
      'model_provider = "deepseek"',
      '',
      '[model_providers.deepseek]',
      'base_url = "https://api.deepseek.example/v1"',
      'env_key = "OPENAI_API_KEY"',
      '',
    ].join('\n'));
    await writeFile(
      join(configHome, 'pi-home', '.pi', 'agent', 'models.json'),
      JSON.stringify({
        providers: {
          kimi: {
            baseUrl: 'https://api.kimi.example/coding/v1',
            apiKey: 'kimi-secret',
            models: [{ id: 'k3', reasoning: true }],
          },
        },
      }),
    );
    await writeFile(
      join(configHome, 'pi-home', '.pi', 'agent', 'settings.json'),
      JSON.stringify({ defaultProvider: 'kimi', defaultModel: 'k3' }),
    );

    await prepareSmokeConfiguration({
      installRoot,
      configHome,
      executorCommand: 'codex',
      executorTimeoutSeconds: 900,
      executorMaxDurationSeconds: 3600,
    });

    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, installRoot);
    const snapshot = await new FileConfigurationRepository(accountPaths.config)
      .getActiveSnapshot();
    expect(snapshot.config.schemaVersion).toBe(2);
    expect(snapshot.config.providers).toMatchObject({
      kimi: { baseUrl: 'https://api.kimi.example/coding/v1' },
      deepseek: { baseUrl: 'https://api.deepseek.example/v1' },
    });
    expect(snapshot.config.models['planner-k3']).toMatchObject({
      providerRef: 'kimi',
      modelId: 'k3',
    });
    expect(snapshot.config.models['codex-deepseek-v4-pro']).toMatchObject({
      providerRef: 'deepseek',
      modelId: 'deepseek-v4-pro',
    });
    expect(snapshot.config.agentClasses.planner.modelPolicy).toEqual({
      mode: 'fixed',
      modelRef: 'planner-k3',
    });
    expect(snapshot.config.agentClasses['codex-cli'].modelPolicy).toEqual({
      mode: 'fixed',
      modelRef: 'codex-deepseek-v4-pro',
    });
    expect(snapshot.config.agentClasses['pi-agent'].modelPolicy).toEqual({
      mode: 'fixed',
      modelRef: 'pi-k3',
    });
    expect(snapshot.config.runtimePolicy.attemptTimeoutMs).toBe(3_600_000);

    const generatedRuntimeRoot = resolve(accountPaths.generated, 'agent-runtime');
    expect(JSON.parse(await readFile(
      join(generatedRuntimeRoot, snapshot.revisionId, 'planner', 'settings.json'),
      'utf8',
    ))).toMatchObject({
      defaultProvider: 'kimi',
      defaultModel: 'k3',
    });
    expect(await readFile(join(generatedRuntimeRoot, 'current'), 'utf8'))
      .toBe(`${snapshot.revisionId}\n`);

    const secrets = new FileSecretStore(accountPaths.secrets);
    await expect(secrets.get('file-secret:anyfusion/providers/kimi'))
      .resolves.toBe('kimi-secret');
    await expect(secrets.get('file-secret:anyfusion/providers/deepseek'))
      .resolves.toBe('deepseek-secret');
  });
});

async function removeTree(root: string): Promise<void> {
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

async function makeWritable(path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info) return;
  await chmod(path, info.isDirectory() ? 0o700 : 0o600).catch(() => undefined);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path)) {
    await makeWritable(join(path, entry));
  }
}
