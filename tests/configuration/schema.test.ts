import { describe, expect, it } from 'vitest';
import { AnyFusionConfigurationV2Schema } from '../../src/configuration/schema.js';

function minimalConfiguration() {
  return {
    schemaVersion: 2,
    providers: {},
    models: {},
    harnesses: {},
    agentClasses: {},
    permissionProfiles: {},
    runtimePolicy: {},
    gateway: {},
  };
}

function completeConfiguration() {
  return {
    schemaVersion: 2,
    providers: {
      openai: {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKeyRef: 'keychain:anyfusion/openai',
        region: 'international',
        enabled: true,
      },
    },
    models: {
      planner: {
        providerRef: 'openai',
        modelId: 'planner-model',
        capabilities: ['planning', 'structured-output'],
        reasoning: 'high',
        enabled: true,
      },
      engineering: {
        providerRef: 'openai',
        modelId: 'engineering-model',
        capabilities: ['coding', 'tools'],
        reasoning: 'medium',
        enabled: true,
      },
    },
    harnesses: {
      'planner-process': {
        kind: 'planner',
        transport: 'local-process',
        commandRef: 'release:planner',
        driverId: 'anyfusion-planner-host-v2',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
      'codex-cli': {
        kind: 'executor',
        transport: 'local-cli',
        command: 'codex',
        args: ['exec'],
        driverId: 'codex-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
    },
    agentClasses: {
      'planner-default': {
        kind: 'planner',
        harnessRef: 'planner-process',
        modelPolicy: {
          mode: 'fixed',
          modelRef: 'planner',
        },
        generatedRuntimeRef: 'planner-default',
        enabled: true,
      },
      'codex-engineering': {
        kind: 'executor',
        harnessRef: 'codex-cli',
        modelPolicy: {
          mode: 'fixed',
          modelRef: 'engineering',
        },
        permissionProfileRef: 'workspace-default',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: ['repository implementation'],
        avoidUseCases: ['current public-web research'],
        plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
        generatedRuntimeRef: 'codex-engineering',
        enabled: true,
      },
    },
    permissionProfiles: {
      'workspace-default': {
        profileId: 'workspace-engineering',
        version: 1,
        parameters: {
          maxAdditionalReadPartitions: 8,
        },
      },
    },
    runtimePolicy: {
      maxConcurrentAttempts: 4,
      attemptTimeoutMs: 600_000,
      probeTimeoutMs: 30_000,
    },
    gateway: {
      enabled: true,
      bindHost: '127.0.0.1',
      port: 8787,
    },
  };
}

describe('AnyFusion configuration schema v2', () => {
  it('accepts the complete empty v2 document shape', () => {
    expect(AnyFusionConfigurationV2Schema.safeParse(minimalConfiguration()).success).toBe(true);
  });

  it('accepts Auto objectives for Executors and model economics metadata', () => {
    const config = completeConfiguration();
    const parsed = AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      models: {
        ...config.models,
        planner: {
          ...config.models.planner,
          contextLimit: 128_000,
          costInputPerMillion: 1.25,
          costOutputPerMillion: 5.5,
          qualityTier: 'high',
          latencyTier: 'low',
        },
      },
      agentClasses: {
        ...config.agentClasses,
        'planner-default': {
          ...config.agentClasses['planner-default'],
          modelPolicy: {
            mode: 'fixed',
            modelRef: 'planner',
          },
        },
        'codex-engineering': {
          ...config.agentClasses['codex-engineering'],
          modelPolicy: {
            mode: 'auto',
            allowedModelRefs: ['engineering'],
            defaultModelRef: 'engineering',
            objective: {
              priority: 'balanced',
              maxCostPerTurn: 0.25,
              maxLatencyMs: 15_000,
              minimumQualityTier: 'medium',
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects Auto policy on Planner AgentClasses', () => {
    const config = completeConfiguration();
    const result = AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      agentClasses: {
        ...config.agentClasses,
        'planner-default': {
          ...config.agentClasses['planner-default'],
          modelPolicy: {
            mode: 'auto',
            allowedModelRefs: ['planner'],
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level and nested fields', () => {
    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...minimalConfiguration(),
      legacyConfigPath: '/Users/test/.metaclaw/config.yaml',
    }).success).toBe(false);

    const config = completeConfiguration();
    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      providers: {
        ...config.providers,
        openai: {
          ...config.providers.openai,
          apiKey: 'raw-secret',
        },
      },
    }).success).toBe(false);
  });

  it('rejects duplicate controlled references', () => {
    const config = completeConfiguration();
    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      agentClasses: {
        ...config.agentClasses,
        'planner-default': {
          ...config.agentClasses['planner-default'],
          modelPolicy: {
            mode: 'auto',
            allowedModelRefs: ['planner', 'planner'],
          },
        },
      },
    }).success).toBe(false);

    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      agentClasses: {
        ...config.agentClasses,
        'codex-engineering': {
          ...config.agentClasses['codex-engineering'],
          routingCapabilities: ['workspace-engineering', 'workspace-engineering'],
        },
      },
    }).success).toBe(false);
  });

  it('rejects missing, unknown, and disabled model references', () => {
    const config = completeConfiguration();

    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      models: {
        ...config.models,
        engineering: {
          ...config.models.engineering,
          enabled: false,
        },
      },
    }).success).toBe(false);

    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      agentClasses: {
        ...config.agentClasses,
        'codex-engineering': {
          ...config.agentClasses['codex-engineering'],
          modelPolicy: { mode: 'fixed' },
        },
      },
    }).success).toBe(false);

    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      agentClasses: {
        ...config.agentClasses,
        'planner-default': {
          ...config.agentClasses['planner-default'],
          modelPolicy: { mode: 'auto', allowedModelRefs: [] },
        },
      },
    }).success).toBe(false);
  });

  it('requires AgentClass and Harness roles to match', () => {
    const config = completeConfiguration();

    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      agentClasses: {
        ...config.agentClasses,
        'planner-default': {
          ...config.agentClasses['planner-default'],
          harnessRef: 'codex-cli',
        },
      },
    }).success).toBe(false);

    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      agentClasses: {
        ...config.agentClasses,
        'codex-engineering': {
          ...config.agentClasses['codex-engineering'],
          harnessRef: 'planner-process',
        },
      },
    }).success).toBe(false);
  });

  it('requires executor affordances to satisfy every declared Routing Capability', () => {
    const config = completeConfiguration();

    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      agentClasses: {
        ...config.agentClasses,
        'codex-engineering': {
          ...config.agentClasses['codex-engineering'],
          plannerAffordances: ['workspace-read-write'],
        },
      },
    }).success).toBe(false);
  });

  it.each([
    ['permissionProfileRef', 'workspace-default'],
    ['routingCapabilities', ['workspace-engineering']],
    ['plannerAffordances', ['workspace-read-write']],
  ])('forbids executor-only %s on Planner AgentClasses', (key, value) => {
    const config = completeConfiguration();

    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      agentClasses: {
        ...config.agentClasses,
        'planner-default': {
          ...config.agentClasses['planner-default'],
          [key]: value,
        },
      },
    }).success).toBe(false);
  });

  it('requires local CLI Harnesses to use a registered driver and bare command', () => {
    const config = completeConfiguration();

    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      harnesses: {
        ...config.harnesses,
        'codex-cli': {
          kind: 'executor',
          transport: 'local-cli',
          driverId: 'codex-cli',
          enabled: true,
        },
      },
    }).success).toBe(false);

    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      harnesses: {
        ...config.harnesses,
        'codex-cli': {
          ...config.harnesses['codex-cli'],
          command: 'sh',
        },
      },
    }).success).toBe(false);

    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      harnesses: {
        ...config.harnesses,
        'codex-cli': {
          ...config.harnesses['codex-cli'],
          command: '/usr/local/bin/codex',
        },
      },
    }).success).toBe(false);

    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      harnesses: {
        ...config.harnesses,
        'codex-cli': {
          ...config.harnesses['codex-cli'],
          driverId: 'arbitrary-shell-driver',
        },
      },
    }).success).toBe(false);
  });

  it('accepts only registered versioned Permission Profiles with bounded parameters', () => {
    const config = completeConfiguration();

    expect(AnyFusionConfigurationV2Schema.safeParse(config).success).toBe(true);
    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      permissionProfiles: {
        'workspace-default': {
          profileId: 'root-access',
          version: 1,
          parameters: {},
        },
      },
    }).success).toBe(false);
    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      permissionProfiles: {
        'workspace-default': {
          profileId: 'workspace-engineering',
          version: 2,
          parameters: {},
        },
      },
    }).success).toBe(false);
  });

  it.each([
    ['rules', [{ effect: 'allow', capability: '*' }]],
    ['command', 'rm -rf /'],
    ['hostPath', '/Users/test'],
    ['secretAccess', ['*']],
    ['policyOverride', { allowElevation: true }],
  ])('rejects arbitrary Permission Profile %s configuration', (key, value) => {
    const config = completeConfiguration();
    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      permissionProfiles: {
        'workspace-default': {
          ...config.permissionProfiles['workspace-default'],
          parameters: {
            ...config.permissionProfiles['workspace-default'].parameters,
            [key]: value,
          },
        },
      },
    }).success).toBe(false);
  });

  it('rejects raw endpoint credentials', () => {
    const config = completeConfiguration();
    expect(AnyFusionConfigurationV2Schema.safeParse({
      ...config,
      providers: {
        openai: {
          ...config.providers.openai,
          baseUrl: 'https://user:password@api.example.com/v1',
        },
      },
    }).success).toBe(false);
  });
});
