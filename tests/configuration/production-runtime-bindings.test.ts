import { describe, expect, it } from 'vitest';
import {
  createProductionRuntimeBindings,
} from '../../src/configuration/production-runtime-bindings.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';
import type { SecretStore } from '../../src/configuration/secret-store.js';

describe('production runtime configuration bindings', () => {
  it('resolves the exact authorized Executor binding with private Provider environment', async () => {
    const snapshot = productionSnapshot();
    const secretStore: SecretStore = {
      get: async reference => {
        expect(reference).toBe('file-secret:anyfusion/provider-key');
        return 'secret-value';
      },
      put: async () => undefined,
      delete: async () => undefined,
    };
    const bindings = createProductionRuntimeBindings({ snapshot, secretStore });

    await expect(bindings.getRuntimeBinding({
      agentClassRef: 'codex-engineering',
      harnessRef: 'codex-cli',
      providerRef: 'provider',
      modelRef: 'model',
      permissionProfileRef: 'workspace-engineering',
      configurationRevision: 'revision-production',
    })).resolves.toMatchObject({
      revisionId: 'revision-production',
      environment: {
        OPENAI_API_KEY: 'secret-value',
        OPENAI_BASE_URL: 'https://provider.example/v1',
        OPENAI_MODEL: 'gpt-test',
      },
    });
    expect(bindings.runtimeConfiguration.revisionId).toBe('revision-production');
    expect(bindings.maxConcurrentAttempts).toBe(2);
  });

  it('loads the revision pinned by a recovered attempt instead of substituting the active revision', async () => {
    const active = productionSnapshot();
    const previous = {
      ...productionSnapshot(),
      revisionId: 'revision-previous',
    };
    const bindings = createProductionRuntimeBindings({
      snapshot: active,
      secretStore: {
        get: async () => 'secret-value',
        put: async () => undefined,
        delete: async () => undefined,
      },
      getSnapshot: async revisionId => {
        expect(revisionId).toBe('revision-previous');
        return previous;
      },
    });

    await expect(bindings.getRuntimeBinding({
      agentClassRef: 'codex-engineering',
      harnessRef: 'codex-cli',
      providerRef: 'provider',
      modelRef: 'model',
      permissionProfileRef: 'workspace-engineering',
      configurationRevision: 'revision-previous',
    })).resolves.toMatchObject({
      revisionId: 'revision-previous',
      environment: {
        OPENAI_API_KEY: 'secret-value',
      },
    });
  });

  it('keeps old revision bindings while exposing an activated revision to new attempts', async () => {
    const active = productionSnapshot();
    const next = {
      ...productionSnapshot(),
      revisionId: 'revision-next',
      config: {
        ...productionSnapshot().config,
        providers: {
          provider: {
            ...productionSnapshot().config.providers.provider,
            baseUrl: 'https://next-provider.example/v1',
          },
        },
        models: {
          model: {
            ...productionSnapshot().config.models.model,
            modelId: 'gpt-next',
          },
        },
      },
    } satisfies ConfigurationSnapshot;
    const bindings = createProductionRuntimeBindings({
      snapshot: active,
      secretStore: {
        get: async () => 'secret-value',
        put: async () => undefined,
        delete: async () => undefined,
      },
      getSnapshot: async revisionId => revisionId === next.revisionId ? next : active,
    });

    bindings.updateSnapshot(next);

    expect(bindings.getActiveRuntimeConfiguration().revisionId).toBe('revision-next');
    expect(bindings.getRuntimeConfiguration(active.revisionId)?.revisionId).toBe(active.revisionId);
    expect(bindings.getRuntimeConfiguration(next.revisionId)?.revisionId).toBe(next.revisionId);
    await expect(bindings.getRuntimeBinding({
      agentClassRef: 'codex-engineering',
      harnessRef: 'codex-cli',
      providerRef: 'provider',
      modelRef: 'model',
      permissionProfileRef: 'workspace-engineering',
      configurationRevision: next.revisionId,
    })).resolves.toMatchObject({
      revisionId: 'revision-next',
      environment: {
        OPENAI_BASE_URL: 'https://next-provider.example/v1',
        OPENAI_MODEL: 'gpt-next',
      },
    });
  });
});

function productionSnapshot(): ConfigurationSnapshot {
  return {
    revisionId: 'revision-production',
    contentHash: 'sha256:production',
    config: {
      schemaVersion: 2,
      providers: {
        provider: {
          protocol: 'openai-compatible',
          baseUrl: 'https://provider.example/v1',
          apiKeyRef: 'file-secret:anyfusion/provider-key',
          region: 'international',
          enabled: true,
        },
      },
      models: {
        model: {
          providerRef: 'provider',
          modelId: 'gpt-test',
          capabilities: ['coding'],
          reasoning: 'high',
          enabled: true,
        },
      },
      harnesses: {
        'codex-cli': {
          kind: 'executor',
          transport: 'local-cli',
          command: 'codex',
          args: [],
          driverId: 'codex-cli',
          supportsProbe: true,
          supportsAbort: true,
          supportsContinuation: false,
          enabled: true,
        },
      },
      agentClasses: {
        'codex-engineering': {
          kind: 'executor',
          harnessRef: 'codex-cli',
          modelPolicy: { mode: 'fixed', modelRef: 'model' },
          permissionProfileRef: 'workspace-engineering',
          routingCapabilities: ['workspace-engineering'],
          primaryUseCases: ['engineering'],
          avoidUseCases: [],
          plannerAffordances: ['workspace-read-write'],
          skills: [],
          mcpServers: [],
          plugins: [],
          generatedRuntimeRef: 'codex-engineering',
          enabled: true,
        },
      },
      permissionProfiles: {
        'workspace-engineering': {
          profileId: 'workspace-engineering',
          version: 1,
          parameters: {},
        },
      },
      runtimePolicy: { maxConcurrentAttempts: 2 },
      gateway: {},
    },
  };
}
