import { describe, expect, it, vi } from 'vitest';
import {
  AnyFusionConfigurationV2Schema,
  parseAnyFusionConfigurationV2,
  SPAN_ROUTING_DEFAULT_TIMEOUT_MS,
} from '../../src/configuration/schema.js';
import {
  buildKernelConfigurationView,
  buildPlannerConfigurationView,
  buildRuntimeConfigurationView,
} from '../../src/configuration/projections.js';
import { classifyConfigurationDiff } from '../../src/configuration/configuration-diff.js';
import {
  ConfigurationRuntimeCoordinator,
} from '../../src/configuration/configuration-runtime-coordinator.js';
import { ConfigurationActivationGate } from '../../src/configuration/configuration-activation-gate.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';

function baseConfiguration(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    providers: {
      openai: {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKeyRef: 'file-secret:anyfusion/providers/openai',
        region: 'international',
        enabled: true,
      },
    },
    models: {
      fast: {
        providerRef: 'openai',
        modelId: 'gpt-fast',
        capabilities: ['coding', 'tools'],
        reasoning: 'low',
        enabled: true,
      },
      deep: {
        providerRef: 'openai',
        modelId: 'gpt-deep',
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
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
      h: {
        kind: 'executor',
        transport: 'local-cli',
        command: 'codex',
        args: [],
        driverId: 'codex-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
    },
    agentClasses: {
      planner: {
        kind: 'planner',
        harnessRef: 'planner',
        modelPolicy: { mode: 'fixed', modelRef: 'fast' },
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
      executor: {
        kind: 'executor',
        harnessRef: 'h',
        modelPolicy: { mode: 'auto', allowedModelRefs: ['fast', 'deep'] },
        permissionProfileRef: 'workspace',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: [],
        avoidUseCases: [],
        plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'executor',
        enabled: true,
      },
    },
    permissionProfiles: { workspace: { profileId: 'workspace-engineering', version: 1, parameters: {} } },
    runtimePolicy: {
      maxConcurrentTasks: 2,
      maxConcurrentAttempts: 4,
      maxConcurrentAttemptsPerTask: 2,
      schedulingAgingMs: 300_000,
      sameConversationQueueLimit: 8,
    },
    gateway: {},
  };
}

function snapshot(revisionId: string, config: Record<string, unknown>): ConfigurationSnapshot {
  return {
    revisionId,
    contentHash: `hash-${revisionId}`,
    config: parseAnyFusionConfigurationV2(config),
  };
}

describe('Span routing configuration schema', () => {
  it('parses revisions created before the routing section existed without materializing it', () => {
    const config = parseAnyFusionConfigurationV2(baseConfiguration());
    expect(config.routing).toBeUndefined();
  });

  it('accepts a valid Span section and applies the default timeout', () => {
    const config = parseAnyFusionConfigurationV2({
      ...baseConfiguration(),
      routing: { span: { enabled: true, model: 'respan/span-01-lite', apiKeyRef: 'file-secret:anyfusion/routing/span' } },
    });
    expect(config.routing?.span).toEqual({
      enabled: true,
      model: 'respan/span-01-lite',
      apiKeyRef: 'file-secret:anyfusion/routing/span',
      timeoutMs: SPAN_ROUTING_DEFAULT_TIMEOUT_MS,
    });
  });

  it('rejects an invalid Span model, timeout, and credential reference', () => {
    for (const span of [
      { enabled: true, model: 'openai/gpt-4o', timeoutMs: 3_000 },
      { enabled: true, model: 'respan/span-01-lite', timeoutMs: 100 },
      { enabled: true, model: 'respan/span-01-lite', timeoutMs: 60_000 },
      { enabled: true, model: 'respan/span-01-lite', apiKeyRef: 'plaintext-key' },
    ]) {
      expect(AnyFusionConfigurationV2Schema.safeParse({
        ...baseConfiguration(),
        routing: { span },
      }).success).toBe(false);
    }
  });
});

describe('Span routing projections', () => {
  const config = snapshot('revision-span', {
    ...baseConfiguration(),
    routing: {
      span: {
        enabled: true,
        model: 'respan/span-01-lite',
        apiKeyRef: 'file-secret:anyfusion/routing/span',
        timeoutMs: 2_500,
      },
    },
  });

  it('exposes the non-sensitive Span policy to the Kernel without the credential reference', () => {
    const kernel = buildKernelConfigurationView(config);
    expect(kernel.spanRouting).toEqual({
      enabled: true,
      model: 'respan/span-01-lite',
      timeoutMs: 2_500,
    });
    expect(JSON.stringify(kernel)).not.toContain('routing/span');
  });

  it('does not leak Span configuration into the Planner projection', () => {
    const planner = buildPlannerConfigurationView(config);
    expect(JSON.stringify(planner)).not.toContain('span-01-lite');
    expect(JSON.stringify(planner)).not.toContain('routing/span');
  });

  it('keeps the full Span section (including apiKeyRef) in the Runtime view for the Server adapter', () => {
    const runtime = buildRuntimeConfigurationView(config);
    expect(runtime.routing?.span?.apiKeyRef).toBe('file-secret:anyfusion/routing/span');
  });
});

describe('Span routing diff classification', () => {
  it('treats adding the Span section as a hot-safe change', () => {
    const before = baseConfiguration();
    const after = {
      ...baseConfiguration(),
      routing: { span: { enabled: true, model: 'respan/span-01-lite', timeoutMs: 3_000 } },
    };
    const classification = classifyConfigurationDiff(before, after);
    expect(classification.classification).toBe('hot');
    expect(classification.restartPaths).toEqual([]);
  });

  it('treats editing the Span section as a hot-safe change', () => {
    const withSpan = (timeoutMs: number) => ({
      ...baseConfiguration(),
      routing: { span: { enabled: true, model: 'respan/span-01-lite', timeoutMs } },
    });
    const classification = classifyConfigurationDiff(withSpan(3_000), withSpan(5_000));
    expect(classification.classification).toBe('hot');
  });
});

describe('Span routing credential activation', () => {
  function coordinatorFixture(failActivation = false) {
    const before = snapshot('revision-before', baseConfiguration());
    const after = snapshot('revision-after', {
      ...baseConfiguration(),
      routing: { span: { enabled: true, model: 'respan/span-01-lite', timeoutMs: 3_000 } },
    });
    const rollback = vi.fn(async () => undefined);
    const prepareConfig = vi.fn(async ({ config, spanApiKey }: {
      config: unknown;
      spanApiKey?: string;
    }) => {
      const candidate = structuredClone(config) as Record<string, unknown>;
      if (spanApiKey !== undefined) {
        candidate.routing = {
          span: { enabled: true, model: 'respan/span-01-lite', timeoutMs: 3_000, apiKeyRef: 'file-secret:anyfusion/routing/span' },
        };
      }
      return candidate;
    });
    const stageSecrets = vi.fn(async () => rollback);
    const coordinator = new ConfigurationRuntimeCoordinator({
      service: {
        getActiveSnapshot: async () => before,
        createDraft: () => ({ revisionId: after.revisionId, baseRevisionId: before.revisionId }),
        validateDraft: () => ({ ok: true as const, config: after.config }),
        compileDraft: () => ({ contentHash: after.contentHash, files: {} }),
        probeDraft: async () => ({ ok: true as const }),
        activateDraft: async () => {
          if (failActivation) throw new Error('activation failed');
          return { ok: true as const, snapshot: after };
        },
      } as never,
      initialSnapshot: before,
      prepareConfig,
      stageSecrets,
      gate: new ConfigurationActivationGate(() => ({
        activeTaskId: null, plannerTurnActive: false, activeAttemptCount: 0,
        activeLeaseCount: 0, publicationPending: false, recoveryInProgress: false,
      })),
    });
    return { coordinator, before, after, rollback, prepareConfig, stageSecrets };
  }

  it('passes the transient Span key through preparation and secret staging', async () => {
    const { coordinator, after, prepareConfig, stageSecrets } = coordinatorFixture();
    const result = await coordinator.activate({
      config: after.config,
      expectedRevisionId: 'revision-before',
      spanApiKey: 'sk-or-span',
    });
    expect(result.ok).toBe(true);
    expect(prepareConfig).toHaveBeenCalledWith(expect.objectContaining({
      spanApiKey: 'sk-or-span',
      baseRevisionId: 'revision-before',
    }));
    expect(stageSecrets).toHaveBeenCalledWith({ secrets: {}, spanApiKey: 'sk-or-span' });
  });

  it('rolls back staged credentials when activation fails', async () => {
    const { coordinator, after, rollback } = coordinatorFixture(true);
    await expect(coordinator.activate({
      config: after.config,
      expectedRevisionId: 'revision-before',
      spanApiKey: 'sk-or-span',
    })).rejects.toThrow('activation failed');
    expect(rollback).toHaveBeenCalledOnce();
  });
});
