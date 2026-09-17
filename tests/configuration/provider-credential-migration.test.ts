import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialsFileSecretStore } from '../../src/configuration/credentials-file-secret-store.js';
import { FileSecretStore } from '../../src/configuration/file-secret-store.js';
import { migrateLegacyProviderCredentials } from '../../src/configuration/provider-credential-migration.js';
import type { ProviderDefinition } from '../../src/configuration/types.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const root of cleanup.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function provider(apiKeyRef: string): ProviderDefinition {
  return {
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    apiKeyRef,
    region: 'international',
    enabled: true,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'metawork-credential-migration-'));
  cleanup.push(root);
  const credentialsFile = join(root, 'credentials.json');
  return {
    root,
    credentialsFile,
    legacySecretsDir: join(root, 'accounts', 'local-default', 'secrets'),
    target: new CredentialsFileSecretStore(credentialsFile),
  };
}

describe('migrateLegacyProviderCredentials', () => {
  it('imports legacy account secrets into the credentials file', async () => {
    const { credentialsFile, legacySecretsDir, target } = fixture();
    const legacyStore = new FileSecretStore(legacySecretsDir);
    await legacyStore.put('file-secret:anyfusion/providers/provider', 'legacy-key');

    const result = await migrateLegacyProviderCredentials({
      target,
      providers: { provider: provider('file-secret:anyfusion/providers/provider') },
      legacySecretsDir,
      env: { METAWORK_SECRET_STORE: 'file' },
    });

    expect(result).toMatchObject({ status: 'migrated', imported: ['provider'], missing: [] });
    expect(JSON.parse(readFileSync(credentialsFile, 'utf8'))).toEqual({
      version: 1,
      providers: { provider: 'legacy-key' },
    });
  });

  it('is inert once the credentials file exists', async () => {
    const { credentialsFile, legacySecretsDir, target } = fixture();
    writeFileSync(credentialsFile, '{"version":1,"providers":{"provider":"current-key"}}\n');
    const legacyStore = new FileSecretStore(legacySecretsDir);
    await legacyStore.put('file-secret:anyfusion/providers/provider', 'stale-key');

    const result = await migrateLegacyProviderCredentials({
      target,
      providers: { provider: provider('file-secret:anyfusion/providers/provider') },
      legacySecretsDir,
      env: { METAWORK_SECRET_STORE: 'file' },
    });

    expect(result).toMatchObject({ status: 'already-migrated', imported: [] });
    expect(JSON.parse(readFileSync(credentialsFile, 'utf8'))).toEqual({
      version: 1,
      providers: { provider: 'current-key' },
    });
  });

  it('fails closed on a malformed credentials file instead of falling back', async () => {
    const { credentialsFile, legacySecretsDir, target } = fixture();
    writeFileSync(credentialsFile, 'not json\n');
    const legacyStore = new FileSecretStore(legacySecretsDir);
    await legacyStore.put('file-secret:anyfusion/providers/provider', 'legacy-key');

    await expect(migrateLegacyProviderCredentials({
      target,
      providers: { provider: provider('file-secret:anyfusion/providers/provider') },
      legacySecretsDir,
      env: { METAWORK_SECRET_STORE: 'file' },
    })).rejects.toThrow('invalid credentials.json');
  });

  it('records the migration marker and the missing providers when a legacy secret is absent', async () => {
    const { credentialsFile, legacySecretsDir, target } = fixture();

    const result = await migrateLegacyProviderCredentials({
      target,
      providers: { provider: provider('file-secret:anyfusion/providers/provider') },
      legacySecretsDir,
      env: { METAWORK_SECRET_STORE: 'file' },
    });

    expect(result).toMatchObject({ status: 'migrated', imported: [], missing: ['provider'] });
    expect(JSON.parse(readFileSync(credentialsFile, 'utf8'))).toEqual({
      version: 1,
      providers: {},
    });
  });

  it('reports an unusable legacy store without failing the caller', async () => {
    const { legacySecretsDir, target, credentialsFile } = fixture();

    const result = await migrateLegacyProviderCredentials({
      target,
      providers: { provider: provider('not-a-secret-reference') },
      legacySecretsDir,
      env: { METAWORK_SECRET_STORE: 'file' },
    });

    expect(result.status).toBe('legacy-store-unavailable');
    expect(result.detail).toBeTruthy();
    expect(() => readFileSync(credentialsFile)).toThrow();
  });
});
