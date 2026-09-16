import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialsFileSecretStore } from '../../src/configuration/credentials-file-secret-store.js';
import { importLegacyProviderCredentials } from '../../src/configuration/legacy-provider-credential-import.js';
import type { ProviderDefinition } from '../../src/configuration/types.js';
import type { SecretReference, SecretStore } from '../../src/configuration/secret-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function provider(ref: string): ProviderDefinition {
  return {
    protocol: 'openai-compatible',
    baseUrl: `https://${ref}.example/v1`,
    apiKeyRef: `keychain:anyfusion/providers/${ref}`,
    region: 'international',
    enabled: true,
  };
}

function memoryStore(values: Record<string, string>): SecretStore {
  return {
    get: async reference => {
      const providerRef = reference.split('/').at(-1)!;
      const value = values[providerRef];
      if (!value) throw new Error('missing');
      return value;
    },
    put: async () => undefined,
    delete: async () => undefined,
  };
}

describe('importLegacyProviderCredentials', () => {
  it('imports readable active Provider credentials into the MetaWork file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-credential-import-'));
    roots.push(root);
    const filePath = join(root, 'credentials.json');
    const target = new CredentialsFileSecretStore(filePath);

    const result = await importLegacyProviderCredentials({
      target,
      providers: {
        openai: provider('openai'),
        missing: provider('missing'),
      },
      legacyStore: memoryStore({ openai: 'sk-openai' }),
    });

    expect(result).toEqual({ imported: ['openai'], missing: ['missing'] });
    expect(await target.get('file-secret:anyfusion/providers/openai')).toBe('sk-openai');
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({
      version: 1,
      providers: { openai: 'sk-openai' },
    });
  });

  it('does not read or overwrite legacy credentials when the target exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-credential-import-'));
    roots.push(root);
    const filePath = join(root, 'credentials.json');
    await writeFile(filePath, JSON.stringify({
      version: 1,
      providers: { openai: 'sk-new' },
    }), 'utf8');
    const target = new CredentialsFileSecretStore(filePath);
    let reads = 0;
    const legacyStore: SecretStore = {
      get: async (_reference: SecretReference) => {
        reads += 1;
        return 'sk-old';
      },
      put: async () => undefined,
      delete: async () => undefined,
    };

    await expect(importLegacyProviderCredentials({
      target,
      targetExists: true,
      providers: { openai: provider('openai') },
      legacyStore,
    })).resolves.toEqual({ imported: [], missing: [] });
    expect(reads).toBe(0);
    await expect(target.get('file-secret:anyfusion/providers/openai')).resolves.toBe('sk-new');
  });

  it('validates an existing credentials file instead of treating malformed data as migrated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-credential-import-'));
    roots.push(root);
    const filePath = join(root, 'credentials.json');
    await writeFile(filePath, '{malformed', 'utf8');
    const target = new CredentialsFileSecretStore(filePath);

    await expect(importLegacyProviderCredentials({
      target,
      providers: { openai: provider('openai') },
      legacyStore: memoryStore({ openai: 'sk-old' }),
    })).rejects.toThrow('invalid credentials.json');
    await expect(readFile(filePath, 'utf8')).resolves.toBe('{malformed');
  });

  it('creates an empty migration marker when no legacy credential is readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-credential-import-'));
    roots.push(root);
    const filePath = join(root, 'credentials.json');
    const target = new CredentialsFileSecretStore(filePath);

    await expect(importLegacyProviderCredentials({
      target,
      providers: { missing: provider('missing') },
      legacyStore: memoryStore({}),
    })).resolves.toEqual({ imported: [], missing: ['missing'] });
    await expect(readFile(filePath, 'utf8')).resolves.toContain('"providers": {}');
  });
});
