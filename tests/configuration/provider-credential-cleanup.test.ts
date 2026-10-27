import { describe, expect, it } from 'vitest';
import {
  cleanupProviderCredentials,
  orphanedProviderCredentialReferences,
} from '../../src/configuration/provider-credential-cleanup.js';
import type { SecretReference, SecretStore } from '../../src/configuration/secret-store.js';
import type { AnyFusionConfigurationV2 } from '../../src/configuration/types.js';

function configuration(providers: Record<string, string>): AnyFusionConfigurationV2 {
  return {
    schemaVersion: 2,
    providers: Object.fromEntries(Object.entries(providers).map(([ref, apiKeyRef]) => [
      ref,
      {
        protocol: 'openai-compatible' as const,
        baseUrl: `https://${ref}.example.test/v1`,
        apiKeyRef,
        region: 'international' as const,
        enabled: true,
      },
    ])),
    models: {},
    harnesses: {},
    agentClasses: {},
    permissionProfiles: {},
    runtimePolicy: { maxConcurrentAttempts: 2, maxConcurrentAttemptsPerTask: 1 },
    gateway: {},
  } as AnyFusionConfigurationV2;
}

class MemoryStore implements SecretStore {
  readonly deleted: SecretReference[] = [];
  constructor(private readonly values: Record<string, string> = {}) {}
  async get(reference: SecretReference): Promise<string> {
    const value = this.values[reference];
    if (value === undefined) throw new Error('missing');
    return value;
  }
  async put(): Promise<void> {}
  async delete(reference: SecretReference): Promise<void> {
    this.deleted.push(reference);
  }
}

describe('Provider credential cleanup after activation', () => {
  it('removes the credential of a Provider the activated revision deleted', () => {
    const previous = configuration({
      deepseek: 'file-secret:anyfusion/providers/deepseek',
      codecli: 'file-secret:anyfusion/providers/codecli',
    });
    const next = configuration({ codecli: 'file-secret:anyfusion/providers/codecli' });

    expect(orphanedProviderCredentialReferences({ previous, next })).toEqual([
      'file-secret:anyfusion/providers/deepseek',
    ]);
  });

  it('keeps a shared credential while any Provider still references it', () => {
    const previous = configuration({
      a: 'file-secret:anyfusion/providers/shared',
      b: 'file-secret:anyfusion/providers/shared',
    });
    const next = configuration({ a: 'file-secret:anyfusion/providers/shared' });

    expect(orphanedProviderCredentialReferences({ previous, next })).toEqual([]);
  });

  it('keeps credentials of Providers that still exist, including renamed ones', () => {
    const previous = configuration({ deepseek: 'file-secret:anyfusion/providers/deepseek' });
    const next = configuration({ deepseek: 'file-secret:anyfusion/providers/renamed' });

    expect(orphanedProviderCredentialReferences({ previous, next })).toEqual([]);
  });

  it('never touches the internal Span routing credential', () => {
    const previous = configuration({ deepseek: 'file-secret:anyfusion/providers/deepseek' });
    const next = {
      ...configuration({}),
      routing: { span: { enabled: true, model: 'm', apiKeyRef: 'file-secret:anyfusion/providers/deepseek' } },
    } as AnyFusionConfigurationV2;

    expect(orphanedProviderCredentialReferences({ previous, next })).toEqual([]);
  });

  it('deletes only orphaned references and tolerates a failing store', async () => {
    const store = new MemoryStore();
    store.delete = async (reference: SecretReference) => {
      if (reference.endsWith('/broken')) throw new Error('keychain locked');
      store.deleted.push(reference);
    };
    const previous = configuration({
      removed: 'file-secret:anyfusion/providers/removed',
      broken: 'file-secret:anyfusion/providers/broken',
    });
    const removed = await cleanupProviderCredentials({
      secretStore: store,
      previous,
      next: configuration({}),
      logger: () => undefined,
    });

    expect(removed).toEqual(['file-secret:anyfusion/providers/removed']);
    expect(store.deleted).toContain('file-secret:anyfusion/providers/removed');
  });
});
