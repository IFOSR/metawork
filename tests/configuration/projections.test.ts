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
        routingNotes: {
          strengths: ['复杂代码重构'],
          limitations: ['不适合视觉设计'],
        },
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
      planner: {
        kind: 'planner',
        harnessRef: 'planner-process',
        modelPolicy: {
          mode: 'fixed',
          modelRef: 'planner',
        },
        generatedRuntimeRef: 'planner',
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
        executorManual: {
          sourceText: '优先用于大型 TypeScript 重构。',
          assertions: [{
            topic: 'preferred-task',
            text: '优先用于大型 TypeScript 重构。',
          }],
        },
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
    expect(view.planner?.modelPolicy).toEqual({ mode: 'fixed', modelRef: 'planner' });
    expect(view.models.map(model => model.id)).toEqual(['engineering', 'planner']);
    expect(view.executorCapabilityManuals).toHaveLength(1);
    expect(view.executorCapabilityManuals?.[0]).toMatchObject({
      agentClassRef: 'codex-engineering',
      configurationRevision: 'revision-2026-08-11',
    });
    expect(view.executorCapabilityManuals?.[0]?.markdown).toContain('优先用于大型 TypeScript 重构。');
    expect(view.routingCatalog.agentClasses[0]?.profileFingerprint)
      .toBe(view.executorCapabilityManuals?.[0]?.sourceFingerprint);
    expect(view.routingCatalog.agentClasses[0]?.routingCapabilities)
      .toEqual(view.executorCapabilityManuals?.[0]?.routableCapabilities);
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

  it('uses the profile-derived routable capabilities in both Planner and Kernel views', () => {
    const candidate = structuredClone(snapshot());
    candidate.config.agentClasses['codex-engineering']!.executorManual = {
      sourceText: '不要把工作区工程任务交给这个 Executor。',
      assertions: [{
        topic: 'capability-policy',
        text: '禁止承担工作区工程任务。',
        routingCapability: 'workspace-engineering',
        disposition: 'disabled',
      }],
    };

    const planner = buildPlannerConfigurationView(candidate);
    const kernel = buildKernelConfigurationView(candidate);

    expect(planner.routingCatalog.agentClasses[0]?.routingCapabilities).toEqual([]);
    expect(planner.executorCapabilityManuals?.[0]?.routableCapabilities).toEqual([]);
    expect(kernel.agentClasses['codex-engineering']?.routingCapabilities).toEqual([]);
  });

  it('projects user-confirmed model capability evidence per Executor', () => {
    const candidate = structuredClone(snapshot());
    candidate.config.agentClasses['codex-engineering']!.executorManual = {
      sourceText: 'engineering 支持图片生成。',
      assertions: [{
        topic: 'model-contribution',
        text: 'engineering 支持图片生成。',
        modelRef: 'engineering',
        modelCapability: 'image-generation',
      }],
    };

    const planner = buildPlannerConfigurationView(candidate);
    const kernel = buildKernelConfigurationView(candidate);

    expect(planner.routingCatalog.agentClasses[0]?.modelCapabilities?.engineering)
      .toContain('image-generation');
    expect(kernel.agentClasses['codex-engineering']?.modelCapabilities?.engineering)
      .toContain('image-generation');
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

  it('projects auto modelPolicy candidates in order and excludes disabled agent classes', () => {
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
        'model-a': { providerRef: 'openai', modelId: 'a', capabilities: ['coding'], reasoning: 'high', enabled: true },
        'model-b': { providerRef: 'openai', modelId: 'b', capabilities: ['coding'], reasoning: 'high', enabled: true },
      },
      harnesses: {
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
        'auto-executor': {
          kind: 'executor',
          harnessRef: 'codex-cli',
          modelPolicy: { mode: 'auto', allowedModelRefs: ['model-a', 'model-b'], defaultModelRef: 'model-a' },
          permissionProfileRef: 'workspace-default',
          routingCapabilities: ['workspace-engineering'],
          primaryUseCases: [],
          avoidUseCases: [],
          plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
          generatedRuntimeRef: 'auto-executor',
          enabled: true,
        },
        'disabled-executor': {
          kind: 'executor',
          harnessRef: 'codex-cli',
          modelPolicy: { mode: 'fixed', modelRef: 'model-a' },
          permissionProfileRef: 'workspace-default',
          routingCapabilities: ['workspace-engineering'],
          primaryUseCases: [],
          avoidUseCases: [],
          plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
          generatedRuntimeRef: 'disabled-executor',
          enabled: false,
        },
      },
      permissionProfiles: {
        'workspace-default': {
          profileId: 'workspace-engineering',
          version: 1,
          parameters: { maxAdditionalReadPartitions: 8 },
        },
      },
      runtimePolicy: { maxConcurrentAttempts: 4, attemptTimeoutMs: 600000, probeTimeoutMs: 30000 },
      gateway: { enabled: true, bindHost: '127.0.0.1', port: 8787 },
    });

    const view = buildPlannerConfigurationView({ revisionId: 'r1', contentHash: 'h', config });
    const catalogAgentClasses = view.routingCatalog.agentClasses;

    expect(catalogAgentClasses.map(agentClass => agentClass.id)).toEqual(['auto-executor']);
    expect(catalogAgentClasses[0].modelPolicy).toEqual({
      mode: 'auto',
      allowedModelRefs: ['model-a', 'model-b'],
      defaultModelRef: 'model-a',
    });
  });
});
