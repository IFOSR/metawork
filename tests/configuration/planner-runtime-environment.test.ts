import { describe, expect, it, vi } from 'vitest';
import type { RevisionedAgentBinding } from '../../src/core/authorized-executor-binding.js';
import type {
  RuntimeConfigurationView,
} from '../../src/configuration/types.js';
import type {
  SecretReference,
  SecretStore,
} from '../../src/configuration/secret-store.js';
import {
  resolvePlannerRuntimeEnvironment,
} from '../../src/configuration/runtime-private-binding-resolver.js';

describe('resolvePlannerRuntimeEnvironment', () => {
  it('resolves the exact revision-pinned Planner provider and model', async () => {
    const secretStore = recordingSecretStore({
      'file-secret:anyfusion/providers/deepseek': 'deepseek-secret',
    });

    const result = await resolvePlannerRuntimeEnvironment({
      configuration: plannerConfiguration(),
      plannerBinding: plannerBinding(),
      secretStore,
    });

    expect(result).toEqual({
      OPENAI_BASE_URL: 'https://api.deepseek.example/v1',
      OPENAI_API_KEY: 'deepseek-secret',
      OPENAI_API_KEY__DEEPSEEK: 'deepseek-secret',
      OPENAI_MODEL: 'deepseek-v4-pro',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(secretStore.get).toHaveBeenCalledWith(
      'file-secret:anyfusion/providers/deepseek',
    );
  });

  it('fails closed when the Planner binding does not match the configured model', async () => {
    const secretStore = recordingSecretStore({
      'file-secret:anyfusion/providers/deepseek': 'deepseek-secret',
    });

    await expect(resolvePlannerRuntimeEnvironment({
      configuration: plannerConfiguration(),
      plannerBinding: plannerBinding({ providerRef: 'kimi' }),
      secretStore,
    })).rejects.toThrow(
      'Provider binding mismatch for Planner Model deepseek-model',
    );
    expect(secretStore.get).not.toHaveBeenCalled();
  });
});

function plannerBinding(
  overrides: Partial<RevisionedAgentBinding> = {},
): RevisionedAgentBinding {
  return {
    agentClassRef: 'planner',
    harnessRef: 'anyfusion-planner',
    providerRef: 'deepseek',
    modelRef: 'deepseek-model',
    permissionProfileRef: null,
    configurationRevision: 'revision-deepseek',
    ...overrides,
  };
}

function plannerConfiguration(): RuntimeConfigurationView {
  return {
    revisionId: 'revision-deepseek',
    contentHash: 'sha256:revision-deepseek',
    schemaVersion: 2,
    providers: {
      deepseek: {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.deepseek.example/v1',
        apiKeyRef: 'file-secret:anyfusion/providers/deepseek',
        region: 'china',
        enabled: true,
      },
    },
    models: {
      'deepseek-model': {
        providerRef: 'deepseek',
        modelId: 'deepseek-v4-pro',
        capabilities: ['planning', 'structured-output', 'tools'],
        reasoning: 'high',
        enabled: true,
      },
    },
    harnesses: {
      'anyfusion-planner': {
        kind: 'planner',
        transport: 'local-process',
        commandRef: 'release:planner',
        args: [],
        driverId: 'anyfusion-planner-host-v2',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
    },
    agentClasses: {
      planner: {
        kind: 'planner',
        harnessRef: 'anyfusion-planner',
        modelPolicy: { mode: 'fixed', modelRef: 'deepseek-model' },
        routingCapabilities: [],
        primaryUseCases: [],
        avoidUseCases: [],
        plannerAffordances: [],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'planner',
        enabled: true,
      },
    },
    permissionProfiles: {},
    runtimePolicy: {},
    gateway: {},
  };
}

function recordingSecretStore(
  values: Partial<Record<SecretReference, string>>,
): SecretStore {
  return {
    get: vi.fn(async (reference: SecretReference) => {
      const value = values[reference];
      if (value === undefined) throw new Error('missing');
      return value;
    }),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}
