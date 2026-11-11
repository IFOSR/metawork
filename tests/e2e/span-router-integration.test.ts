import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { RouteDecisionRepo } from '../../src/storage/route-decision-repo.js';
import {
  RouterService,
  type RouteRequest,
} from '../../src/routing/router.js';
import { SpanRouterModel } from '../../src/routing/span-router-model.js';
import { RouterDispatchService } from '../../src/execution/router-dispatch-service.js';
import {
  SpanRoutingAdvisor,
  type SpanDecisionClient,
} from '../../src/routing/span-routing-advisor.js';
import type {
  SpanRoutingEvaluator,
  SpanSubtaskEvaluationRequest,
} from '../../src/routing/span-routing-types.js';

/**
 * Router decision-model integration (ADR-0055 D1/D4).
 *
 * The Router owns the joint AgentClass/Provider/Model choice; the Span model is
 * only its decision adapter. This file runs the same four representative
 * workloads as `scripts/smoke-span-routing.mjs --integration`:
 *
 *  - offline (default `npm test`): a deterministic adapter proves the Router
 *    contract, persistence and replay without any external call;
 *  - live (`SPAN_LIVE_INTEGRATION=1`, credentialed operator smoke): the real
 *    Server advisor answers, and each scenario prints one machine-readable
 *    `{"scenario": ...}` sample.
 *
 * Nothing here prints the credential, the raw request or the raw provider
 * payload.
 */

const configurationRevision = 'revision-span-router-integration';

interface Workload {
  readonly name: 'simple' | 'complex' | 'research' | 'single';
  readonly goal: string;
  readonly acceptance: readonly string[];
  readonly agents: readonly string[];
}

const workloads: readonly Workload[] = [
  {
    name: 'simple',
    goal: 'Fix a spelling mistake in a comment',
    acceptance: ['The comment reads correctly'],
    agents: ['codex-fast', 'pi-general'],
  },
  {
    name: 'complex',
    goal: 'Design and implement a concurrent parser with recovery and property tests',
    acceptance: ['Parser handles concurrent input', 'Property tests cover recovery'],
    agents: ['codex-fast', 'pi-general'],
  },
  {
    name: 'research',
    goal: 'Compare parser algorithms and document evidence and tradeoffs',
    acceptance: ['Evidence per algorithm', 'Tradeoffs documented'],
    agents: ['codex-fast', 'pi-general'],
  },
  {
    name: 'single',
    goal: 'Fix one comment using the only eligible binding',
    acceptance: ['The comment reads correctly'],
    agents: ['pi-general'],
  },
];

function routeRequest(workload: Workload): RouteRequest {
  const candidates = workload.agents.map(agentClassRef => ({
    agentClassRef,
    providerRef: 'openai',
    modelRef: `${agentClassRef}-model`,
    permissionProfileRef: 'workspace-default',
  }));
  return {
    taskId: `task_${workload.name}`,
    generationId: `generation_${workload.name}`,
    subtaskId: 'subtask_execute',
    graphRevision: 1,
    attemptOrdinal: 1,
    goal: workload.goal,
    acceptance: workload.acceptance,
    configurationRevision,
    candidates,
    excluded: [],
    modelCatalog: candidates.map(candidate => ({
      providerRef: candidate.providerRef,
      modelRef: candidate.modelRef,
      modelId: `gpt-5.${workload.name}`,
    })),
  };
}

/** Deterministic decision adapter: prefers the last candidate. */
function deterministicEvaluator(): SpanRoutingEvaluator & { evaluate: ReturnType<typeof vi.fn> } {
  const evaluate = vi.fn(async (input: {
    requests: readonly SpanSubtaskEvaluationRequest[];
  }) => ({
    subtasks: input.requests.map(request => ({
      subtaskId: request.subtaskId,
      candidateSetFingerprint: request.candidateSetFingerprint,
      status: 'advised' as const,
      resolvedModel: 'fixture-decision-model',
      candidates: request.request.candidates.map((binding, index, all) => ({
        candidateId: binding.questionId,
        agentClassRef: binding.agentClassRef,
        providerRef: binding.providerRef,
        modelRef: binding.modelRef,
        probability: index === all.length - 1 ? 0.8 : 0.2 / Math.max(1, all.length - 1),
      })),
    })),
  }));
  return { evaluate } as unknown as SpanRoutingEvaluator & { evaluate: ReturnType<typeof vi.fn> };
}

function liveEvaluator(target: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}): SpanRoutingEvaluator {
  // ADR-0055 D4: the decision model is the configured Provider/Model, so the
  // live path resolves it exactly like the Server does instead of falling back
  // to a fixed vendor endpoint.
  return new SpanRoutingAdvisor({
    resolveApiKey: async () => target.apiKey,
    resolveDecisionModels: async () => (target.baseUrl && target.model
      ? [{ model: target.model, apiKey: target.apiKey, baseUrl: target.baseUrl }]
      : []),
    // The smoke owns its own timeout budget below; the default SDK retry policy
    // stays disabled inside the advisor.
    maxConcurrent: 1,
  }) as SpanRoutingEvaluator;
}

const live = process.env.SPAN_LIVE_INTEGRATION === '1';

describe('Span Router decision-model integration', () => {
  it.each(workloads.map(workload => [workload.name, workload] as const))(
    'routes representative workload %s',
    async (name, workload) => {
      const request = routeRequest(workload);
      const adapter = live
        ? liveEvaluator({
          apiKey: process.env.SPAN_INTEGRATION_API_KEY ?? '',
          baseUrl: process.env.SPAN_INTEGRATION_BASE_URL,
          model: process.env.SPAN_INTEGRATION_MODEL,
        })
        : deterministicEvaluator();
      const evaluate = vi.fn(adapter.evaluate.bind(adapter));
      const model = new SpanRouterModel({ evaluator: { evaluate }, timeoutMs: 10_000 });
      const router = new RouterService({ model });
      const startedAt = Date.now();
      const decision = await router.decide(request);
      const latencyMs = Date.now() - startedAt;

      expect(decision.candidates).toHaveLength(request.candidates.length);
      expect(decision.outcome).toBe('selected');
      expect(decision.selected).not.toBeNull();
      expect(request.candidates).toContainEqual(decision.selected);
      // A single eligible candidate is selected without paying for a decision call.
      expect(evaluate).toHaveBeenCalledTimes(name === 'single' ? 0 : 1);

      if (live) {
        // Machine-readable sample consumed by the operator smoke script.
        console.log(JSON.stringify({
          scenario: name,
          latencyMs,
          outcome: decision.outcome,
          selected: decision.selected
            ? [decision.selected.agentClassRef, decision.selected.providerRef, decision.selected.modelRef]
            : null,
          candidates: decision.candidates.length,
          resolvedModel: name === 'single'
            ? 'single-candidate'
            : live ? process.env.SPAN_INTEGRATION_MODEL ?? null : 'fixture-decision-model',
          replayCalls: 0,
        }));
      }
    },
    30_000,
  );

  it('persists one decision per Attempt and replays it without another model call', async () => {
    const db = new Database(':memory:');
    initializeDatabaseSchema(db);
    try {
      const request = routeRequest(workloads[0]!);
      const evaluator = deterministicEvaluator();
      const model = new SpanRouterModel({ evaluator, timeoutMs: 10_000 });
      const router = new RouterService({ model });
      const service = new RouterDispatchService({
        router,
        decisions: new RouteDecisionRepo(db),
      });
      const first = await service.route({ request, readCurrentRequest: () => request });
      const replay = await service.route({ request, readCurrentRequest: () => request });
      expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
      expect(replay.routeDecisionId).toBe(first.routeDecisionId);
      expect(replay.selected).toEqual(first.selected);
    } finally {
      db.close();
    }
  });

  it('never selects a candidate outside the eligible set', async () => {
    const request = routeRequest(workloads[0]!);
    const outOfSet: SpanDecisionClient = {
      create: async () => ({
        model: 'inception/mercury-decide:free',
        answers: { candidates: { type: 'choice', choice: 'c999', probabilities: { c999: 1 } } },
        usage: { input_tokens: 10, output_tokens: 0, cost: 0 },
      }),
    };
    const advisor = new SpanRoutingAdvisor({
      resolveApiKey: async () => 'integration-fake-credential',
      createClient: () => outOfSet,
    });
    const router = new RouterService({
      model: new SpanRouterModel({ evaluator: advisor, timeoutMs: 5_000 }),
    });
    const decision = await router.decide(request);
    // The validator rejects the unknown option, so the provider text is never
    // trusted; the Router falls back to its deterministic default binding and
    // records why instead of stranding the Subtask.
    expect(decision.outcome).toBe('selected');
    expect(decision.selection).toBe('default_fallback');
    expect(decision.unavailableReason).toBe('span_candidate_mismatch');
    expect(decision.selected).toEqual(request.candidates[0]);
  });

  it('keeps cancelled routing from producing a decision', async () => {
    const request = routeRequest(workloads[1]!);
    const controller = new AbortController();
    controller.abort();
    const evaluator = deterministicEvaluator();
    const router = new RouterService({
      model: new SpanRouterModel({ evaluator, timeoutMs: 5_000 }),
    });
    await expect(router.decide(request, controller.signal)).rejects.toMatchObject({ code: 'route_cancelled' });
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });
});
