import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSecretStore } from '../../src/configuration/file-secret-store.js';
import { KeychainSecretStore } from '../../src/configuration/keychain-secret-store.js';
import { CredentialsFileSecretStore } from '../../src/configuration/credentials-file-secret-store.js';
import {
  createLegacyProductionSecretStore,
  createProductionSecretStore,
  prepareProductionSecretStore,
} from '../../src/configuration/production-secret-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('production SecretStore selection', () => {
  it('uses the explicit MetaWork credentials file when provided', () => {
    expect(createProductionSecretStore({
      credentialsFile: '/Users/test/.metawork/credentials.json',
    })).toBeInstanceOf(CredentialsFileSecretStore);
  });

  it('uses Keychain by default on macOS', () => {
    expect(createLegacyProductionSecretStore({
      platform: 'darwin',
      secretsRoot: '/unused',
      env: {},
    })).toBeInstanceOf(KeychainSecretStore);
  });

  it('follows the active configuration reference scheme on macOS', () => {
    expect(createLegacyProductionSecretStore({
      platform: 'darwin',
      secretsRoot: '/secrets',
      env: {},
      references: [
        'file-secret:anyfusion/providers/deepseek',
        'file-secret:anyfusion/providers/kimi',
      ],
    })).toBeInstanceOf(FileSecretStore);

    expect(createLegacyProductionSecretStore({
      platform: 'darwin',
      secretsRoot: '/unused',
      env: {},
      references: ['keychain:anyfusion/providers/openai'],
    })).toBeInstanceOf(KeychainSecretStore);
  });

  it('fails closed when one active revision mixes secret store schemes', () => {
    expect(() => createLegacyProductionSecretStore({
      platform: 'darwin',
      secretsRoot: '/unused',
      env: {},
      references: [
        'file-secret:anyfusion/providers/deepseek',
        'keychain:anyfusion/providers/openai',
      ],
    })).toThrow('mixes secret reference schemes');
  });

  it('requires an explicit file fallback on non-macOS platforms', async () => {
    expect(() => createLegacyProductionSecretStore({
      platform: 'linux',
      secretsRoot: '/unused',
      env: {},
    })).toThrow('METAWORK_SECRET_STORE=file');

    const root = await mkdtemp(join(tmpdir(), 'anyfusion-production-secrets-'));
    roots.push(root);
    const store = createLegacyProductionSecretStore({
      platform: 'linux',
      secretsRoot: root,
      env: { ANYFUSION_SECRET_STORE: 'file' },
    });
    expect(store).toBeInstanceOf(FileSecretStore);
    await prepareProductionSecretStore(store);
  });

  it('uses the canonical MetaWork secret-store setting', () => {
    expect(createLegacyProductionSecretStore({
      platform: 'linux',
      secretsRoot: '/secrets',
      env: { METAWORK_SECRET_STORE: 'file' },
    })).toBeInstanceOf(FileSecretStore);
  });

  it('fails closed when canonical and compatibility secret-store settings conflict', () => {
    expect(() => createLegacyProductionSecretStore({
      platform: 'darwin',
      secretsRoot: '/unused',
      env: {
        METAWORK_SECRET_STORE: 'file',
        ANYFUSION_SECRET_STORE: 'keychain',
      },
    })).toThrow(
      'METAWORK_SECRET_STORE conflicts with compatibility variable ANYFUSION_SECRET_STORE',
    );
  });

  it('never silently falls back from a requested Keychain store', () => {
    expect(() => createLegacyProductionSecretStore({
      platform: 'linux',
      secretsRoot: '/unused',
      env: { ANYFUSION_SECRET_STORE: 'keychain' },
    })).toThrow('requires macOS');
  });
});
