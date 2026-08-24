import { describe, expect, it } from 'vitest';
import { AnyFusionConfigurationV2Schema } from '../../src/configuration/schema.js';

function configuration() {
  return {
    schemaVersion: 2,
    providers: {
      first: {
        protocol: 'openai-compatible',
        baseUrl: 'https://first.example/v1',
        apiKeyRef: 'keychain:anyfusion/first',
        region: 'international',
        enabled: true,
      },
      second: {
        protocol: 'openai-compatible',
        baseUrl: 'https://second.example/v1',
        apiKeyRef: 'keychain:anyfusion/second',
        region: 'international',
        enabled: true,
      },
    },
    models: {
      planner: {
        providerRef: 'first',
        modelId: 'planner-model',
        capabilities: ['planning', 'structured-output'],
        reasoning: 'high',
        enabled: true,
      },
      'codex-first': {
        providerRef: 'first',
        modelId: 'gpt-5.6-sol',
        capabilities: ['coding', 'tools'],
        reasoning: 'high',
        enabled: true,
      },
      'codex-second': {
        providerRef: 'second',
        modelId: 'gpt-5.6-sol',
        capabilities: ['coding', 'tools'],
        reasoning: 'high',
        enabled: true,
      },
    },
    harnesses: {
      planner: {
        kind: 'planner',
        transport: 'local-process',
        commandRef: 'release:planner',
        args: [],
        driverId: 'anyfusion-planner-host-v2',
        enabled: true,
      },
      codex: {
        kind: 'executor',
        transport: 'local-cli',
        command: 'codex',
        args: [],
        driverId: 'codex-cli',
        enabled: true,
      },
    },
    agentClasses: {
      planner: {
        kind: 'planner',
        harnessRef: 'planner',
        modelPolicy: { mode: 'fixed', modelRef: 'planner' },
        generatedRuntimeRef: 'planner',
        enabled: true,
      },
      codex: {
        kind: 'executor',
        harnessRef: 'codex',
        modelPolicy: {
          mode: 'auto',
          allowedModelRefs: ['codex-first', 'codex-second'],
          defaultModelRef: 'codex-first',
        },
        permissionProfileRef: 'workspace-default',
        routingCapabilities: ['workspace-engineering'],
        plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
        generatedRuntimeRef: 'codex',
        enabled: true,
      },
    },
    permissionProfiles: {
      'workspace-default': {
        profileId: 'workspace-engineering',
        version: 1,
        parameters: {},
      },
    },
    runtimePolicy: {},
    gateway: {},
  };
}

describe('Provider catalog routing contract', () => {
  it('allows the same model ID from different Providers', () => {
    expect(AnyFusionConfigurationV2Schema.safeParse(configuration()).success).toBe(true);
  });

  it('allows multiple internal refs for the same Provider model identity', () => {
    const config = configuration();
    const duplicate = {
      ...config,
      models: {
        ...config.models,
        duplicate: {
          ...config.models['codex-first'],
          modelId: 'gpt-5.6-sol',
        },
      },
    };

    expect(AnyFusionConfigurationV2Schema.safeParse(duplicate).success).toBe(true);
  });

  it('requires Auto default preference to remain inside the allowed pool', () => {
    const config = configuration();
    const invalid = {
      ...config,
      agentClasses: {
        ...config.agentClasses,
        codex: {
          ...config.agentClasses.codex,
          modelPolicy: {
            mode: 'auto',
            allowedModelRefs: ['codex-first'],
            defaultModelRef: 'codex-second',
          },
        },
      },
    };

    expect(AnyFusionConfigurationV2Schema.safeParse(invalid).success).toBe(false);
  });
});
