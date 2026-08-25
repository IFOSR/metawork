import { describe, expect, it } from 'vitest';
import { ConfigurationActivationGate } from '../../src/configuration/configuration-activation-gate.js';
import { ConfigurationRuntimeCoordinator } from '../../src/configuration/configuration-runtime-coordinator.js';
import { createProductionRuntimeBindings } from '../../src/configuration/production-runtime-bindings.js';
import { AutoModelResolver } from '../../src/routing/auto-model-resolver.js';
import { WorkGraphPresentationProjector } from '../../src/management/work-graph-presentation-projector.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';

describe('hot activation, auto routing, and Work Graph presentation', () => {
  it('activates without restart, keeps old bindings pinned, routes image input, and projects the DAG', async () => {
    const before = e2eSnapshot('revision-before', 'https://old.example/v1', 'old-model');
    const after = e2eSnapshot('revision-after', 'https://new.example/v1', 'new-model');
    let active = before;
    const runtimeBindings = createProductionRuntimeBindings({
      snapshot: before,
      secretStore: {
        get: async () => 'test-secret',
        put: async () => undefined,
        delete: async () => undefined,
      },
      getSnapshot: async revisionId => revisionId === before.revisionId ? before : after,
    });
    const oldBinding = {
      agentClassRef: 'codex-cli',
      harnessRef: 'codex',
      providerRef: 'provider',
      modelRef: 'model',
      permissionProfileRef: 'workspace-engineering',
      configurationRevision: before.revisionId,
    };
    const newBinding = { ...oldBinding, configurationRevision: after.revisionId };
    const oldRuntime = await runtimeBindings.getRuntimeBinding(oldBinding);

    const service = {
      getActiveSnapshot: async () => active,
      createDraft: () => ({ revisionId: after.revisionId, baseRevisionId: before.revisionId }),
      validateDraft: () => ({ ok: true as const, config: after.config }),
      compileDraft: () => ({ contentHash: after.contentHash, files: {} }),
      probeDraft: async () => ({ ok: true as const }),
      activateDraft: async () => {
        active = after;
        return { ok: true as const, snapshot: after };
      },
    };
    const coordinator = new ConfigurationRuntimeCoordinator({
      service: service as never,
      gate: new ConfigurationActivationGate(() => ({
        activeTaskId: null,
        plannerTurnActive: false,
        activeAttemptCount: 0,
        activeLeaseCount: 0,
        publicationPending: false,
        recoveryInProgress: false,
      })),
      initialSnapshot: before,
      onActivated: ({ snapshot }) => runtimeBindings.updateSnapshot(snapshot),
    });

    await expect(coordinator.activate({
      config: after.config,
      expectedRevisionId: before.revisionId,
    })).resolves.toMatchObject({
      ok: true,
      classification: 'hot',
    });

    const newRuntime = await runtimeBindings.getRuntimeBinding(newBinding);
    expect(oldRuntime.environment?.OPENAI_BASE_URL).toBe('https://old.example/v1');
    expect(newRuntime.environment?.OPENAI_BASE_URL).toBe('https://new.example/v1');

    const routed = AutoModelResolver.resolve({
      configurationRevision: after.revisionId,
      agentClassRef: 'planner',
      harnessRef: 'planner',
      permissionProfileRef: 'planner-none',
      policy: { mode: 'auto', allowedModelRefs: ['text', 'vision'] },
      candidates: [
        {
          providerRef: 'provider',
          modelRef: 'text',
          modelId: 'text',
          capabilities: ['planning', 'structured-output'],
          contextLimit: 32_000,
          health: 'healthy',
          available: true,
        },
        {
          providerRef: 'provider',
          modelRef: 'vision',
          modelId: 'vision',
          capabilities: ['planning', 'structured-output', 'vision'],
          contextLimit: 32_000,
          health: 'healthy',
          available: true,
        },
      ],
      requirements: {
        requiredCapabilities: ['planning', 'structured-output', 'vision'],
        contextTokens: 2_000,
        requiresStructuredOutput: true,
      },
    });
    expect(routed.binding?.modelRef).toBe('vision');

    const projection = new WorkGraphPresentationProjector().project({
      taskId: 'task-e2e',
      graphRevision: 1,
      configuration: after,
      graph: {
        schemaVersion: 7,
        configurationRevision: after.revisionId,
        reason: 'e2e',
        subtasks: [{
          id: 'inspect',
          title: 'Inspect image',
          goal: 'Inspect the supplied image',
          dependencies: [],
          contextRefs: [],
          requiredCapabilities: ['workspace-engineering'],
          executorBindings: [{ agentClassRef: 'codex-cli', modelSelection: { mode: 'agent-class-default' } }],
          deliveryKind: 'report',
          acceptance: [{ key: 'report', description: 'Produce a report', requiredEvidence: [] }],
          riskLevel: 'low',
        }],
      },
      subtasks: [{
        id: 'inspect',
        status: 'ready',
        generationId: 'generation-e2e',
        firstDispatchOrder: 0,
        hasPendingOrActiveAttempt: false,
      }],
      decisions: [{
        taskId: 'task-e2e',
        subtaskId: 'inspect',
        action: 'authorize_task_plan',
        authorizedBindings: [newBinding],
        routing: [{
          agentClassRef: 'codex-cli',
          binding: newBinding,
          rejectedCandidates: [{ providerRef: 'provider', modelRef: 'text', reason: 'missing_capability:vision' }],
          scoreBreakdown: null,
          policyVersion: 'auto-model-routing-v1',
        }],
      }],
      dispatchItems: [{ subtaskId: 'inspect', status: 'running', authorizedBinding: newBinding }],
      receipts: [],
      publications: [],
    });

    expect(projection.currentRunnableFrontier).toEqual(['task-e2e_r1_inspect']);
    expect(projection.nodes[0]?.routing[0]).toMatchObject({
      policy: 'auto',
      selected: {
        modelDisplayName: 'new-model',
        providerDisplayName: 'Provider',
      },
    });
    expect(projection.nodes[0]?.routing[0]?.rejectedCandidates).toHaveLength(1);
  });
});

function e2eSnapshot(
  revisionId: string,
  baseUrl: string,
  modelId: string,
): ConfigurationSnapshot {
  return {
    revisionId,
    contentHash: `hash-${revisionId}`,
    config: {
      schemaVersion: 2,
      providers: {
        provider: {
          protocol: 'openai-compatible',
          baseUrl,
          apiKeyRef: 'file-secret:anyfusion/provider',
          region: 'international',
          enabled: true,
        },
      },
      models: {
        model: {
          providerRef: 'provider',
          modelId,
          capabilities: ['coding', 'tools'],
          reasoning: 'medium',
          enabled: true,
        },
      },
      harnesses: {
        codex: {
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
        'codex-cli': {
          kind: 'executor',
          harnessRef: 'codex',
          modelPolicy: { mode: 'fixed', modelRef: 'model' },
          permissionProfileRef: 'workspace-engineering',
          routingCapabilities: ['workspace-engineering'],
          primaryUseCases: [],
          avoidUseCases: [],
          plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
          skills: [],
          mcpServers: [],
          plugins: [],
          generatedRuntimeRef: 'codex-cli',
          enabled: true,
        },
        planner: {
          kind: 'planner',
          harnessRef: 'codex',
          modelPolicy: { mode: 'fixed', modelRef: 'model' },
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
      permissionProfiles: {
        'workspace-engineering': {
          profileId: 'workspace-engineering',
          version: 1,
          parameters: {},
        },
      },
      runtimePolicy: {},
      gateway: {},
    },
  };
}
