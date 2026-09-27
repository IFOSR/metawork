import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { DurableKernelWorkflow } from '../../src/kernel/kernel-workflow.js';
import {
  ControlKernel,
  type KernelEvent,
  type KernelSnapshot,
} from '../../src/kernel/control-kernel.js';
import type { KernelConfigurationView } from '../../src/configuration/index.js';
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';
import type { WorkGraphProposal } from '../../src/work-graph/types.js';
import { attachSpanRoutingObservation } from '../../src/session/span-plan-preparation.js';
import { SpanRoutingAdvisor } from '../../src/routing/span-routing-advisor.js';
import type {
  SpanRoutingEvaluator,
  SpanSubtaskEvaluationRequest,
} from '../../src/routing/span-routing-types.js';

const configurationRevision = 'revision-span-e2e';

const kernelConfiguration: KernelConfigurationView = {
  revisionId: configurationRevision,
  contentHash: 'sha256:span-e2e',
  agentClasses: {
    'codex-fast': {
      kind: 'executor', harnessRef: 'codex-harness', driverId: 'codex-cli',
      modelPolicy: { mode: 'auto', allowedModelRefs: ['model-fast', 'model-deep'], defaultModelRef: 'model-fast' },
      permissionProfileRef: 'workspace-default', routingCapabilities: ['workspace-engineering'],
      enabled: true, transport: 'local-cli', supportsProbe: true, supportsAbort: true, supportsContinuation: true,
    },
    'pi-general': {
      kind: 'executor', harnessRef: 'pi-harness', driverId: 'pi-cli',
      modelPolicy: { mode: 'auto', allowedModelRefs: ['model-fast', 'model-deep'], defaultModelRef: 'model-fast' },
      permissionProfileRef: 'workspace-default', routingCapabilities: ['workspace-engineering'],
      enabled: true, transport: 'local-cli', supportsProbe: true, supportsAbort: true, supportsContinuation: false,
    },
  },
  models: {
    'model-fast': { providerRef: 'openai', modelId: 'gpt-fast', capabilities: ['coding', 'tools'], reasoning: 'low', latencyTier: 'low', enabled: true },
    'model-deep': { providerRef: 'openai', modelId: 'gpt-deep', capabilities: ['coding', 'tools'], reasoning: 'high', latencyTier: 'high', enabled: true },
  },
  providers: { openai: { enabled: true } },
  permissionProfiles: { 'workspace-default': { profileId: 'workspace-engineering', version: 1, parameters: {} } },
  runtimePolicy: {},
  spanRouting: { enabled: true, model: 'respan/span-01-lite', timeoutMs: 3_000 },
};

const runtimeConfiguration = {
  revisionId: configurationRevision,
  contentHash: 'sha256:span-e2e',
  schemaVersion: 2 as const,
  providers: {}, models: {}, harnesses: {}, agentClasses: {}, permissionProfiles: {},
  runtimePolicy: {}, gateway: {},
  routing: { span: { enabled: true, model: 'respan/span-01-lite' as const, apiKeyRef: 'file-secret:anyfusion/internal/routing-span', timeoutMs: 3_000 } },
};

const workGraph: WorkGraphProposal = {
  schemaVersion: 7,
  configurationRevision,
  reason: 'span e2e',
  subtasks: [{
    id: 'subtask_execute',
    title: 'Implement parser',
    goal: 'Implement the parser',
    dependencies: [],
    contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'],
    executorBindings: [
      { agentClassRef: 'codex-fast', modelSelection: { mode: 'agent-class-default' } },
      { agentClassRef: 'pi-general', modelSelection: { mode: 'agent-class-default' } },
    ],
    deliveryKind: 'edit',
    acceptance: [{ key: 'c1', description: 'Works', requiredEvidence: [] }],
    riskLevel: 'low',
  }],
};

const proposal: PlanningAgentPlan = {
  id: 'plan_span_e2e', schemaVersion: 8, action: 'plan_work_graph', confidence: 0.9,
  reason: 'span e2e', clarificationQuestion: null, response: { directReply: null },
  task: {
    binding: 'new', taskId: null, control: 'none', scope: null,
    title: 'Implement parser', goal: 'Implement the parser',
    includeRecentConversationContext: false, priority: { level: 'normal', reason: 'test' },
  },
  risk: { level: 'low', requiresConfirmation: false, reasons: [] },
  authorizationResolution: null, workGraph, source: 'anyfusion-planner',
};

function planEvent(id = 'event_span_e2e'): Extract<KernelEvent, { type: 'plan_proposed' }> {
  return {
    schemaVersion: 5, configurationRevision, type: 'plan_proposed', id,
    correlationId: 'request_span_e2e', causationId: null,
    occurredAt: '2026-09-27T00:00:00.000Z', sessionId: 'session_span_e2e',
    conversationId: 'conversation_span_e2e', proposal, requestText: 'Implement the parser',
    generationId: 'generation_span_e2e', proposalSource: 'initial', targetGraphRevision: 1,
    attachmentIds: [],
  };
}

const snapshot: KernelSnapshot = {
  schemaVersion: 5, type: 'plan_admission', tasks: [], runningTaskId: null,
  plannerConfiguration: {
    revisionId: configurationRevision, contentHash: 'sha256:planner',
    models: [
      { id: 'model-fast', providerRef: 'openai', capabilities: ['coding', 'tools'], reasoning: 'low', region: 'international' },
      { id: 'model-deep', providerRef: 'openai', capabilities: ['coding', 'tools'], reasoning: 'high', region: 'international' },
    ],
    routingCatalog: {
      version: 2, configurationRevision,
      capabilities: [{ id: 'workspace-engineering', deliveryContract: 'Modify files.' }],
      agentClasses: [
        { id: 'codex-fast', routingCapabilities: ['workspace-engineering'], capabilityPreferences: [], profileFingerprint: 'a', modelPolicy: { mode: 'auto', allowedModelRefs: ['model-fast', 'model-deep'], defaultModelRef: 'model-fast' } },
        { id: 'pi-general', routingCapabilities: ['workspace-engineering'], capabilityPreferences: [], profileFingerprint: 'b', modelPolicy: { mode: 'auto', allowedModelRefs: ['model-fast', 'model-deep'], defaultModelRef: 'model-fast' } },
      ],
    },
  },
  kernelConfiguration,
  executorStatuses: [],
  v5WorkGraphTaskIds: [],
  eligibleContextRefKeys: ['current_user_input'],
  pendingAuthorizationRequest: null,
};

function advisingEvaluator(preferredAgentClass: 'codex-fast' | 'pi-general') {
  const evaluate = vi.fn(async (input: {
    deadlineMs: number;
    requests: readonly SpanSubtaskEvaluationRequest[];
  }) => ({
    subtasks: input.requests.map(request => ({
      subtaskId: request.subtaskId,
      candidateSetFingerprint: request.candidateSetFingerprint,
      status: 'advised' as const,
      resolvedModel: 'respan/span-01-lite-20260925',
      candidates: request.request.candidates.map(binding => ({
        candidateId: binding.questionId,
        agentClassRef: binding.agentClassRef,
        providerRef: binding.providerRef,
        modelRef: binding.modelRef,
        probability: binding.agentClassRef === preferredAgentClass ? 0.9 : 0.2,
      })),
    })),
  }));
  return { evaluate } satisfies SpanRoutingEvaluator & { evaluate: typeof evaluate };
}

function seedConfigurationRevision(db: Database.Database): void {
  db.prepare(`
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES (?, 'test-content', 'native', '2026-09-27T00:00:00.000Z')
  `).run(configurationRevision);
}

describe('Span routing end-to-end (mock advisor + real SQLite)', () => {
  it.each([
    ['simple', 'Fix a spelling mistake in a comment', false],
    ['complex', 'Design and implement a concurrent parser with recovery and property tests', false],
    ['research', 'Compare parser algorithms and document evidence and tradeoffs', false],
    ['single', 'Fix one comment using the only eligible binding', true],
  ] as const)('compares representative workload %s and replays durable observations', async (name, goal, single) => {
    const db = new Database(':memory:'); runMigrations(db); seedConfigurationRevision(db);
    try {
      const configuration = structuredClone(kernelConfiguration);
      configuration.models['model-fast']!.modelId = 'gpt-5-mini';
      configuration.models['model-deep']!.modelId = 'gpt-5';
      if (single) configuration.agentClasses['codex-fast']!.modelPolicy = {
        mode: 'auto', allowedModelRefs: ['model-fast'], defaultModelRef: 'model-fast',
      };
      const baseEvent = structuredClone(planEvent(`event-comparison-${name}`));
      baseEvent.requestText = goal;
      baseEvent.proposal.task.goal = goal;
      baseEvent.proposal.workGraph!.subtasks[0]!.goal = goal;
      if (single) baseEvent.proposal.workGraph!.subtasks[0]!.executorBindings =
        baseEvent.proposal.workGraph!.subtasks[0]!.executorBindings.slice(0, 1);
      const admission = { ...snapshot, kernelConfiguration: configuration };
      const deterministic = new ControlKernel().decide(baseEvent, admission);
      const live = process.env.SPAN_LIVE_INTEGRATION === '1';
      const adapter = live ? new SpanRoutingAdvisor({ resolveApiKey: async () => process.env.SPAN_INTEGRATION_API_KEY ?? null })
        : advisingEvaluator('pi-general');
      const evaluate = vi.fn(adapter.evaluate.bind(adapter));
      const start = Date.now();
      const enriched = await attachSpanRoutingObservation({ event: baseEvent, configuration,
        executorStatuses: [], runtimeConfiguration: { ...runtimeConfiguration,
          routing: { span: { ...runtimeConfiguration.routing.span, timeoutMs: 10_000 } } },
        evaluator: { evaluate },
      });
      const latencyMs = Date.now() - start;
      expect(enriched.spanRouting?.subtasks[0]?.status).toBe(single ? 'skipped' : 'advised');
      const store = new KernelWorkflowRepo(db);
      const workflow = new DurableKernelWorkflow({ kernel: new ControlKernel(), buildSnapshot: () => admission,
        store, runtime: { apply: async () => null }, clock: { now: () => baseEvent.occurredAt } });
      const result = await workflow.submit(enriched);
      const advised = result.decisions[0]!;
      expect(deterministic.action.type).toBe('authorize_task_plan');
      expect(advised.action.type).toBe('authorize_task_plan');
      if (advised.action.type !== 'authorize_task_plan' || deterministic.action.type !== 'authorize_task_plan') return;
      const bindings = advised.action.authorizedBindingsBySubtask.subtask_execute!;
      expect(bindings).toHaveLength(single ? 1 : 2);
      expect(new Set(bindings.map(b => b.agentClassRef)).size).toBe(bindings.length);
      const callCount = evaluate.mock.calls.length;
      expect(callCount).toBe(single ? 0 : 1);
      const restarted = new DurableKernelWorkflow({ kernel: new ControlKernel(), buildSnapshot: () => admission,
        store: new KernelWorkflowRepo(db), runtime: { apply: async () => null }, clock: { now: () => baseEvent.occurredAt } });
      await restarted.submit(store.findEvent(enriched.id)!);
      expect(evaluate).toHaveBeenCalledTimes(callCount);
      if (live) console.log(JSON.stringify({ scenario: name, latencyMs,
        deterministic: deterministic.action.authorizedBindingsBySubtask.subtask_execute!.map(b => [b.agentClassRef, b.modelRef]),
        advised: bindings.map(b => [b.agentClassRef, b.modelRef]),
        usage: enriched.spanRouting?.subtasks[0]?.usage ?? null, replayCalls: 0 }));
    } finally { db.close(); }
  }, 15_000);

  it('persists the observation, authorizes the advised order, and replays without a second API call', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedConfigurationRevision(db);
    const store = new KernelWorkflowRepo(db);
    const evaluator = advisingEvaluator('pi-general');
    const baseEvent = planEvent();
    const enriched = await attachSpanRoutingObservation({
      event: baseEvent,
      configuration: kernelConfiguration,
      executorStatuses: [],
      runtimeConfiguration: runtimeConfiguration,
      evaluator,
    });
    expect(enriched.spanRouting).toBeDefined();
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);

    const workflow = new DurableKernelWorkflow({
      kernel: new ControlKernel(),
      buildSnapshot: () => snapshot,
      store,
      runtime: { apply: async () => null },
      clock: { now: () => baseEvent.occurredAt },
    });
    const first = await workflow.submit(enriched);
    const decision = first.decisions[0]!;
    if (decision.action.type !== 'authorize_task_plan') {
      throw new Error(`unexpected decision: ${decision.action.type} (${decision.reason})`);
    }
    expect(decision.action.authorizedBindingsBySubtask.subtask_execute!.map(b => b.agentClassRef))
      .toEqual(['pi-general', 'codex-fast']);

    // Persisted facts: the event JSON round-trips the observation and no ledger
    // row leaks the credential or the raw provider payload.
    const persisted = store.findEvent(enriched.id);
    expect(persisted && 'spanRouting' in persisted && persisted.spanRouting).toBeTruthy();
    const decisionRow = db.prepare('SELECT decision_json, event_json FROM kernel_decisions WHERE event_id = ?')
      .get(enriched.id) as { decision_json: string; event_json: string };
    expect(decisionRow.event_json).toContain('span-routing-v1');
    expect(decisionRow.event_json).not.toContain('sk-');
    expect(decisionRow.decision_json).not.toContain('file-secret');

    // Replaying the stored event must not call the advisor again.
    const replay = await workflow.submit(persisted as Extract<KernelEvent, { type: 'plan_proposed' }>);
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    const replayDecision = replay.decisions[0] ?? store.listRecoverableApplications();
    expect(replayDecision).toBeDefined();
    const storedAfterReplay = store.findEvent(enriched.id);
    expect(JSON.stringify(storedAfterReplay?.spanRouting)).toEqual(JSON.stringify(enriched.spanRouting));
  });

  it('keeps the deterministic binding order when the advisor fails closed', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedConfigurationRevision(db);
    const store = new KernelWorkflowRepo(db);
    const failing: SpanRoutingEvaluator = {
      evaluate: vi.fn(async (input: { requests: readonly SpanSubtaskEvaluationRequest[] }) => ({
        subtasks: input.requests.map(request => ({
          subtaskId: request.subtaskId,
          candidateSetFingerprint: request.candidateSetFingerprint,
          status: 'fallback' as const,
          reason: 'span_http_error' as const,
        })),
      })),
    };
    const baseEvent = planEvent('event_span_failure');
    const enriched = await attachSpanRoutingObservation({
      event: baseEvent,
      configuration: kernelConfiguration,
      executorStatuses: [],
      runtimeConfiguration: runtimeConfiguration,
      evaluator: failing,
    });
    const workflow = new DurableKernelWorkflow({
      kernel: new ControlKernel(),
      buildSnapshot: () => snapshot,
      store,
      runtime: { apply: async () => null },
      clock: { now: () => baseEvent.occurredAt },
    });
    const result = await workflow.submit(enriched);
    const decision = result.decisions[0]!;
    if (decision.action.type !== 'authorize_task_plan') throw new Error(decision.reason);
    expect(decision.action.authorizedBindingsBySubtask.subtask_execute!.map(b => b.agentClassRef))
      .toEqual(['codex-fast', 'pi-general']);
    expect(decision.action.routing.subtask_execute![0]!.spanRouting).toMatchObject({
      applied: false,
      reason: 'span_http_error',
    });
  });

  it('does not invoke the advisor when Policy is disabled', async () => {
    const evaluator = advisingEvaluator('pi-general');
    const enriched = await attachSpanRoutingObservation({
      event: planEvent('event_span_disabled'),
      configuration: kernelConfiguration,
      executorStatuses: [],
      runtimeConfiguration: {
        ...runtimeConfiguration,
        routing: { span: { enabled: false, model: 'respan/span-01-lite' as const, timeoutMs: 3_000 } },
      },
      evaluator,
    });
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(enriched.spanRouting).toBeUndefined();
  });
});
