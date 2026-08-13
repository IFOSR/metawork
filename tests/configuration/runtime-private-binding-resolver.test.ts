import { describe, expect, it, vi } from 'vitest';
import {
  authorizedExecutorBindingFingerprint,
  type AuthorizedExecutorBinding,
} from '../../src/core/authorized-executor-binding.js';
import type {
  AgentClassDefinition,
  RuntimeConfigurationView,
} from '../../src/configuration/types.js';
import type {
  SecretReference,
  SecretStore,
} from '../../src/configuration/secret-store.js';
import {
  resolveRuntimePrivateConfigurationBinding,
} from '../../src/configuration/runtime-private-binding-resolver.js';

describe('resolveRuntimePrivateConfigurationBinding', () => {
  it('resolves an exact authorized binding to an in-memory Provider environment', async () => {
    const configuration = runtimeConfiguration();
    const authorizedBinding = binding();
    const secretStore = recordingSecretStore({
      'keychain:anyfusion/provider-main': 'sk-attempt-secret',
    });

    const result = await resolveRuntimePrivateConfigurationBinding({
      configuration,
      authorizedBinding,
      secretStore,
    });

    expect(result).toEqual({
      revisionId: 'revision-10',
      bindingFingerprint: authorizedExecutorBindingFingerprint(authorizedBinding),
      environment: {
        OPENAI_BASE_URL: 'https://api.example.com/v1',
        OPENAI_API_KEY: 'sk-attempt-secret',
        OPENAI_MODEL: 'engineering-v1',
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.environment)).toBe(true);
    expect(secretStore.get).toHaveBeenCalledOnce();
    expect(secretStore.get).toHaveBeenCalledWith('keychain:anyfusion/provider-main');
    expect(secretStore.put).not.toHaveBeenCalled();
    expect(secretStore.delete).not.toHaveBeenCalled();
  });

  it('accepts a Kernel-authorized model listed by an auto AgentClass policy', async () => {
    const configuration = runtimeConfiguration({
      modelPolicy: {
        mode: 'auto',
        allowedModelRefs: ['model-engineering', 'model-review'],
        defaultModelRef: 'model-engineering',
      },
    });
    const authorizedBinding = binding({ modelRef: 'model-review' });
    const secretStore = recordingSecretStore({
      'keychain:anyfusion/provider-main': 'sk-attempt-secret',
    });

    const result = await resolveRuntimePrivateConfigurationBinding({
      configuration,
      authorizedBinding,
      secretStore,
    });

    expect(result.environment?.OPENAI_MODEL).toBe('review-v1');
  });

  it('rejects an enabled Model outside a fixed AgentClass policy', async () => {
    const secretStore = recordingSecretStore({
      'keychain:anyfusion/provider-main': 'sk-attempt-secret',
    });

    await expect(resolveRuntimePrivateConfigurationBinding({
      configuration: runtimeConfiguration(),
      authorizedBinding: binding({ modelRef: 'model-review' }),
      secretStore,
    })).rejects.toThrow('Model binding is not enabled: model-review');

    expect(secretStore.get).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'configuration revision',
      change: { configurationRevision: 'revision-other' },
      message: /configuration revision mismatch/i,
    },
    {
      name: 'Harness',
      change: { harnessRef: 'other-harness' },
      message: /Harness binding mismatch/i,
    },
    {
      name: 'Provider',
      change: { providerRef: 'provider-other' },
      message: /Provider binding mismatch/i,
    },
    {
      name: 'Model',
      change: { modelRef: 'model-unapproved' },
      message: /Model binding is not enabled/i,
    },
    {
      name: 'Permission Profile',
      change: { permissionProfileRef: 'permission-other' },
      message: /Permission Profile binding mismatch/i,
    },
  ])('fails closed on $name drift before reading a secret', async ({ change, message }) => {
    const secretStore = recordingSecretStore({
      'keychain:anyfusion/provider-main': 'sk-attempt-secret',
    });

    await expect(resolveRuntimePrivateConfigurationBinding({
      configuration: runtimeConfiguration(),
      authorizedBinding: binding(change),
      secretStore,
    })).rejects.toThrow(message);

    expect(secretStore.get).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'disabled AgentClass',
      configuration: runtimeConfiguration({ agentClassEnabled: false }),
      message: /Executor AgentClass is not enabled/i,
    },
    {
      name: 'disabled Harness',
      configuration: runtimeConfiguration({ harnessEnabled: false }),
      message: /Executor Harness is not enabled/i,
    },
    {
      name: 'disabled Provider',
      configuration: runtimeConfiguration({ providerEnabled: false }),
      message: /Provider is not enabled/i,
    },
    {
      name: 'unsupported Provider protocol',
      configuration: runtimeConfiguration({ providerProtocol: 'anthropic' }),
      message: /Provider protocol is not supported/i,
    },
  ])('fails closed for $name before reading a secret', async ({
    configuration,
    message,
  }) => {
    const secretStore = recordingSecretStore({
      'keychain:anyfusion/provider-main': 'sk-attempt-secret',
    });

    await expect(resolveRuntimePrivateConfigurationBinding({
      configuration,
      authorizedBinding: binding(),
      secretStore,
    })).rejects.toThrow(message);

    expect(secretStore.get).not.toHaveBeenCalled();
  });

  it('fails closed when the Provider secret cannot be resolved', async () => {
    const secretStore = recordingSecretStore({});

    await expect(resolveRuntimePrivateConfigurationBinding({
      configuration: runtimeConfiguration(),
      authorizedBinding: binding(),
      secretStore,
    })).rejects.toThrow(/Provider credential could not be resolved/i);

    expect(secretStore.put).not.toHaveBeenCalled();
    expect(secretStore.delete).not.toHaveBeenCalled();
  });

  it('rejects an invalid Provider secret reference before using SecretStore', async () => {
    const configuration = runtimeConfiguration();
    configuration.providers['provider-main'].apiKeyRef = 'raw-secret';
    const secretStore = recordingSecretStore({});

    await expect(resolveRuntimePrivateConfigurationBinding({
      configuration,
      authorizedBinding: binding(),
      secretStore,
    })).rejects.toThrow('invalid secret reference');

    expect(secretStore.get).not.toHaveBeenCalled();
  });

  it('rejects an empty Provider secret without exposing it in diagnostics', async () => {
    const secretStore = recordingSecretStore({
      'keychain:anyfusion/provider-main': '   ',
    });

    await expect(resolveRuntimePrivateConfigurationBinding({
      configuration: runtimeConfiguration(),
      authorizedBinding: binding(),
      secretStore,
    })).rejects.toThrow('Provider credential is empty: provider-main');
  });
});

function binding(
  overrides: Partial<AuthorizedExecutorBinding> = {},
): AuthorizedExecutorBinding {
  return {
    agentClassRef: 'implementation-alpha',
    harnessRef: 'shared-harness',
    providerRef: 'provider-main',
    modelRef: 'model-engineering',
    permissionProfileRef: 'permission-main',
    configurationRevision: 'revision-10',
    ...overrides,
  };
}

function runtimeConfiguration(options: {
  agentClassEnabled?: boolean;
  harnessEnabled?: boolean;
  providerEnabled?: boolean;
  providerProtocol?: 'openai-compatible' | 'anthropic';
  modelPolicy?: AgentClassDefinition['modelPolicy'];
} = {}): RuntimeConfigurationView {
  return {
    revisionId: 'revision-10',
    contentHash: 'sha256:revision-10',
    schemaVersion: 2,
    providers: {
      'provider-main': {
        protocol: options.providerProtocol ?? 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKeyRef: 'keychain:anyfusion/provider-main',
        region: 'international',
        enabled: options.providerEnabled ?? true,
      },
    },
    models: {
      'model-engineering': {
        providerRef: 'provider-main',
        modelId: 'engineering-v1',
        capabilities: ['coding', 'tools'],
        reasoning: 'medium',
        enabled: true,
      },
      'model-review': {
        providerRef: 'provider-main',
        modelId: 'review-v1',
        capabilities: ['coding', 'structured-output'],
        reasoning: 'high',
        enabled: true,
      },
    },
    harnesses: {
      'shared-harness': {
        kind: 'executor',
        transport: 'local-cli',
        command: 'codex',
        args: [],
        driverId: 'codex-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: options.harnessEnabled ?? true,
      },
    },
    agentClasses: {
      'implementation-alpha': {
        kind: 'executor',
        harnessRef: 'shared-harness',
        modelPolicy: options.modelPolicy ?? {
          mode: 'fixed',
          modelRef: 'model-engineering',
        },
        permissionProfileRef: 'permission-main',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: [],
        avoidUseCases: [],
        plannerAffordances: ['workspace-read-write'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'generated-runtime',
        enabled: options.agentClassEnabled ?? true,
      },
    },
    permissionProfiles: {
      'permission-main': {
        profileId: 'workspace-engineering',
        version: 1,
        parameters: {},
      },
    },
    runtimePolicy: {},
    gateway: {},
  };
}

function recordingSecretStore(
  secrets: Partial<Record<SecretReference, string>>,
): SecretStore {
  return {
    get: vi.fn(async reference => {
      const secret = secrets[reference];
      if (secret === undefined) throw new Error('secret not found');
      return secret;
    }),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}
