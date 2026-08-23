import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  importLocalAgentCredentials,
  importLocalAgentCredentialsForRefs,
} from '../../src/configuration/local-agent-credentials.js';
import type { ProviderDefinition } from '../../src/configuration/types.js';
import type { SecretReference, SecretStore } from '../../src/configuration/secret-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('local Agent credential import', () => {
  it('imports a Codex credential for the configured Provider without replacing an existing secret', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anyfusion-local-credentials-'));
    roots.push(home);
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'codex-local-secret' }),
    );
    await writeFile(join(home, '.codex', 'config.toml'), [
      'model_provider = "code-cli"',
      '',
      '[model_providers.code-cli]',
      'base_url = "https://www.code-cli.cn/v1"',
      'env_key = "OPENAI_API_KEY"',
      '',
    ].join('\n'));

    const store = new MemorySecretStore();
    const providers: Record<string, ProviderDefinition> = {
      'code-cli': {
        protocol: 'openai-compatible',
        baseUrl: 'https://www.code-cli.cn/v1',
        apiKeyRef: 'file-secret:anyfusion/providers/code-cli',
        region: 'international',
        enabled: true,
      },
      kimi: {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.kimi.com/coding/v1',
        apiKeyRef: 'file-secret:anyfusion/providers/kimi',
        region: 'international',
        enabled: true,
      },
    };

    await importLocalAgentCredentials({
      home,
      environment: {},
      providers,
      secretStore: store,
    });

    await expect(store.get('file-secret:anyfusion/providers/code-cli'))
      .resolves.toBe('codex-local-secret');
    expect(store.puts).toEqual([
      ['file-secret:anyfusion/providers/code-cli', 'codex-local-secret'],
    ]);
  });

  it('imports a Pi Provider credential from its local models configuration', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anyfusion-local-credentials-'));
    roots.push(home);
    await mkdir(join(home, '.pi', 'agent'), { recursive: true });
    await writeFile(join(home, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        kimi: {
          baseUrl: 'https://api.kimi.com/coding/v1',
          apiKey: 'kimi-local-secret',
          models: [{ id: 'k3' }],
        },
      },
    }));

    const store = new MemorySecretStore();
    const providers: Record<string, ProviderDefinition> = {
      kimi: {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.kimi.com/coding/v1',
        apiKeyRef: 'file-secret:anyfusion/providers/kimi',
        region: 'international',
        enabled: true,
      },
    };

    await importLocalAgentCredentials({ home, providers, secretStore: store });

    await expect(store.get('file-secret:anyfusion/providers/kimi'))
      .resolves.toBe('kimi-local-secret');
  });

  it('updates a stale SecretStore credential from the local Agent source', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anyfusion-local-credentials-'));
    roots.push(home);
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'codex-local-secret' }),
    );
    await writeFile(join(home, '.codex', 'config.toml'), [
      'model_provider = "code-cli"',
      '',
      '[model_providers.code-cli]',
      'base_url = "https://www.code-cli.cn/v1"',
      '',
    ].join('\n'));

    const store = new MemorySecretStore();
    store.values.set('file-secret:anyfusion/providers/code-cli', 'managed-secret');

    await importLocalAgentCredentials({
      home,
      environment: {},
      providers: {
        'code-cli': {
          protocol: 'openai-compatible',
          baseUrl: 'https://www.code-cli.cn/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/code-cli',
          region: 'international',
          enabled: true,
        },
      },
      secretStore: store,
    });

    await expect(store.get('file-secret:anyfusion/providers/code-cli'))
      .resolves.toBe('codex-local-secret');
    expect(store.puts).toEqual([
      ['file-secret:anyfusion/providers/code-cli', 'codex-local-secret'],
    ]);
  });

  it('imports a Pi auth entry when the local Provider name has a coding suffix', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anyfusion-local-credentials-'));
    roots.push(home);
    await mkdir(join(home, '.pi', 'agent'), { recursive: true });
    await writeFile(join(home, '.pi', 'agent', 'auth.json'), JSON.stringify({
      'kimi-coding': { type: 'api_key', key: 'kimi-local-secret' },
    }));

    const store = new MemorySecretStore();
    await importLocalAgentCredentials({
      home,
      providers: {
        kimi: {
          protocol: 'openai-compatible',
          baseUrl: 'https://api.kimi.com/coding/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/kimi',
          region: 'international',
          enabled: true,
        },
      },
      secretStore: store,
    });

    await expect(store.get('file-secret:anyfusion/providers/kimi'))
      .resolves.toBe('kimi-local-secret');
  });

  it('preheats a built-in Provider credential before that Provider is in the active configuration', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anyfusion-local-credentials-'));
    roots.push(home);
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'codex-local-secret' }),
    );
    await writeFile(join(home, '.codex', 'config.toml'), [
      'model_provider = "code-cli"',
      '',
      '[model_providers.code-cli]',
      'base_url = "https://www.code-cli.cn/v1"',
      '',
    ].join('\n'));

    const store = new MemorySecretStore();
    await importLocalAgentCredentialsForRefs({
      home,
      environment: {},
      providers: {
        'code-cli': 'file-secret:anyfusion/providers/code-cli',
      },
      secretStore: store,
    });

    await expect(store.get('file-secret:anyfusion/providers/code-cli'))
      .resolves.toBe('codex-local-secret');
  });

  it('imports the Codex env_key credential from the process environment', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anyfusion-local-credentials-'));
    roots.push(home);
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'wrong-auth-file-secret' }),
    );
    await writeFile(join(home, '.codex', 'config.toml'), [
      'model_provider = "code-cli"',
      '',
      '[model_providers.code-cli]',
      'base_url = "https://www.code-cli.cn/v1"',
      'env_key = "CODE_CLI_API_KEY"',
      '',
    ].join('\n'));

    const store = new MemorySecretStore();
    await importLocalAgentCredentialsForRefs({
      home,
      environment: { CODE_CLI_API_KEY: 'environment-secret' },
      providers: {
        'code-cli': 'file-secret:anyfusion/providers/code-cli',
      },
      secretStore: store,
    });

    await expect(store.get('file-secret:anyfusion/providers/code-cli'))
      .resolves.toBe('environment-secret');
  });

  it('imports a Codex environment credential without requiring auth.json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anyfusion-local-credentials-'));
    roots.push(home);
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'config.toml'), [
      'model_provider = "code-cli"',
      '',
      '[model_providers.code-cli]',
      'base_url = "https://www.code-cli.cn/v1"',
      'env_key = "CODE_CLI_API_KEY"',
      '',
    ].join('\n'));

    const store = new MemorySecretStore();
    await importLocalAgentCredentialsForRefs({
      home,
      environment: { CODE_CLI_API_KEY: 'environment-secret' },
      providers: {
        'code-cli': 'file-secret:anyfusion/providers/code-cli',
      },
      secretStore: store,
    });

    await expect(store.get('file-secret:anyfusion/providers/code-cli'))
      .resolves.toBe('environment-secret');
  });

  it('imports credentials from an alternate local Agent home and resolves env references', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anyfusion-local-credentials-'));
    roots.push(home);
    const codexHome = join(home, 'managed-codex');
    const piHome = join(home, 'managed-pi');
    await mkdir(codexHome, { recursive: true });
    await mkdir(join(piHome, 'agent'), { recursive: true });
    await writeFile(join(codexHome, 'config.toml'), [
      'model_provider = "code-cli"',
      '',
      '[model_providers.code-cli]',
      'base_url = "https://www.code-cli.cn/v1"',
      'env_key = "CODE_CLI_API_KEY"',
      '',
    ].join('\n'));
    await writeFile(join(piHome, 'agent', 'models.json'), JSON.stringify({
      providers: {
        'code-cli': {
          baseUrl: 'https://www.code-cli.cn/v1',
          apiKey: '$CODE_CLI_API_KEY',
          models: [{ id: 'gpt-5.6-sol' }],
        },
      },
    }));

    const store = new MemorySecretStore();
    await importLocalAgentCredentials({
      home,
      codexHomes: [codexHome],
      piHomes: [piHome],
      environment: { CODE_CLI_API_KEY: 'environment-secret' },
      providers: {
        'code-cli': {
          protocol: 'openai-compatible',
          baseUrl: 'https://www.code-cli.cn/v1',
          apiKeyRef: 'file-secret:anyfusion/providers/code-cli',
          region: 'international',
          enabled: true,
        },
      },
      secretStore: store,
    });

    await expect(store.get('file-secret:anyfusion/providers/code-cli'))
      .resolves.toBe('environment-secret');
  });
});

class MemorySecretStore implements SecretStore {
  readonly values = new Map<SecretReference, string>();
  readonly puts: Array<[SecretReference, string]> = [];

  async get(reference: SecretReference): Promise<string> {
    const value = this.values.get(reference);
    if (value === undefined) throw new Error('missing');
    return value;
  }

  async put(reference: SecretReference, value: string): Promise<void> {
    this.values.set(reference, value);
    this.puts.push([reference, value]);
  }

  async delete(reference: SecretReference): Promise<void> {
    this.values.delete(reference);
  }
}
