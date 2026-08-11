import { describe, expect, it } from 'vitest';
import {
  buildKernelConfigurationView,
  buildPlannerConfigurationView,
  buildRuntimeConfigurationView,
} from '../../src/configuration/projections.js';
import { AnyFusionConfigurationV2Schema } from '../../src/configuration/schema.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';

function snapshot(): ConfigurationSnapshot {
  const config = AnyFusionConfigurationV2Schema.parse({
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
      remote: {
        kind: 'executor',
        transport: 'a2a',
        endpoint: 'https://agents.example.com/a2a',
        authTokenRef: 'keychain:anyfusion/a2a',
        driverId: 'a2a-v1',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: false,
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
  });

  return {
    revisionId: 'revision-2026-08-11',
    contentHash: 'sha256:configuration',
    config,
  };
}

const unsafeProjectionKeyPattern =
  /"(?:apiKeyRef|command|commandRef|baseUrl|endpoint|authTokenRef|credential)"\s*:/i;
const hostPathPattern = /\/Users\/|\/home\/|[A-Za-z]:\\/;

describe('configuration projections', () => {
  it('builds a Planner-safe immutable view without launch or credential material', () => {
    const view = buildPlannerConfigurationView(snapshot());
    const serialized = JSON.stringify(view);

    expect(view.revisionId).toBe('revision-2026-08-11');
    expect(view.routingCatalog.agentClasses.map(agentClass => agentClass.id)).toEqual([
      'codex-engineering',
    ]);
    expect(view.models.map(model => model.id)).toEqual(['engineering', 'planner']);
    expect(serialized).not.toMatch(unsafeProjectionKeyPattern);
    expect(serialized).not.toMatch(hostPathPattern);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.routingCatalog.agentClasses)).toBe(true);
  });

  it('builds a Kernel-safe immutable view without secrets, commands, or raw endpoints', () => {
    const view = buildKernelConfigurationView(snapshot());
    const serialized = JSON.stringify(view);

    expect(view.revisionId).toBe('revision-2026-08-11');
    expect(view.agentClasses['codex-engineering']).toMatchObject({
      kind: 'executor',
      harnessRef: 'codex-cli',
      permissionProfileRef: 'workspace-default',
      transport: 'local-cli',
      supportsProbe: true,
      supportsAbort: true,
      supportsContinuation: true,
    });
    expect(serialized).not.toMatch(unsafeProjectionKeyPattern);
    expect(serialized).not.toMatch(hostPathPattern);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.agentClasses)).toBe(true);
  });

  it('retains private launch and credential references only in the Runtime view', () => {
    const view = buildRuntimeConfigurationView(snapshot());
    const serialized = JSON.stringify(view);

    expect(serialized).toContain('apiKeyRef');
    expect(serialized).toContain('command');
    expect(serialized).toContain('authTokenRef');
    expect(serialized).toContain('https://agents.example.com/a2a');
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.harnesses)).toBe(true);
  });
});
