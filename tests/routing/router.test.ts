import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { RouteDecisionRepo } from '../../src/storage/route-decision-repo.js';
import { RouterDispatchService } from '../../src/execution/router-dispatch-service.js';
import { RouterError, RouterService, type RouteRequest } from '../../src/routing/router.js';

const request: RouteRequest = {
  taskId: 'task-1', generationId: 'gen-1', subtaskId: 'sub-1', graphRevision: 1,
  attemptOrdinal: 1, goal: 'write a report', acceptance: ['report exists'],
  configurationRevision: 'rev-1',
  candidates: [{ agentClassRef: 'pi', providerRef: 'p', modelRef: 'm', permissionProfileRef: 'standard-agent' }],
  excluded: [], modelCatalog: [{ providerRef: 'p', modelRef: 'm', modelId: 'model' }],
};

describe('RouterService', () => {
  it('requires the model to disambiguate multiple models for one AgentClass', async () => {
    const multiple = { ...request, candidates: [...request.candidates, { ...request.candidates[0]!, modelRef: 'other' }],
      modelCatalog: [...request.modelCatalog, { providerRef: 'p', modelRef: 'other', modelId: 'other-model' }] };
    const ambiguous = new RouterService({ model: { providerRef: 'p', modelRef: 'r',
      decide: async () => ({ selectedAgentClassRef: 'pi', rationale: 'ambiguous' }) } });
    await expect(ambiguous.decide(multiple)).rejects.toMatchObject({ code: 'route_invalid_output' });
    const exact = new RouterService({ model: { providerRef: 'p', modelRef: 'r', decide: async () => ({
      selectedAgentClassRef: 'pi', selectedProviderRef: 'p', selectedModelRef: 'other', rationale: 'exact fit',
    }) } });
    await expect(exact.decide(multiple)).resolves.toMatchObject({ selected: { modelRef: 'other' } });
  });

  it('replays the durable route and rejects changed graph/candidate facts', async () => {
    const db = new Database(':memory:');
    try {
      let calls = 0;
      const router = new RouterService({ model: { providerRef: 'p', modelRef: 'r', decide: async () => {
        calls++; return { selectedAgentClassRef: 'pi', rationale: 'fit' };
      } } });
      const decisions = new RouteDecisionRepo(db);
      const service = new RouterDispatchService({ router, decisions });
      const first = await service.route({ request, readCurrentRequest: () => request });
      expect(await service.route({ request, readCurrentRequest: () => request })).toEqual(first);
      expect(calls).toBe(1);
      await expect(service.route({ request: { ...request, graphRevision: 2 }, readCurrentRequest: () => request }))
        .rejects.toMatchObject({ code: 'route_stale_decision' });
      expect(() => decisions.record(request, { ...first, selected: { ...first.selected!, modelRef: 'forged' } }))
        .toThrow('route_decision_input_mismatch');
      expect(decisions.record(request, { ...first, decisionModel: { providerRef: 'p', modelRef: 'different' } }))
        .toBe('conflict');
    } finally { db.close(); }
  });
  it('persists a model selection as a fact without a second approval step', async () => {
    const router = new RouterService({
      model: { providerRef: 'p', modelRef: 'router', decide: async () => ({ selectedAgentClassRef: 'pi', rationale: 'best fit' }) },
      createId: () => 'route-1', now: () => '2026-11-08T00:00:00.000Z',
    });
    await expect(router.decide(request)).resolves.toMatchObject({
      routeDecisionId: 'route-1', outcome: 'selected', selected: { agentClassRef: 'pi' },
    });
  });

  it('returns no-candidate without asking a default model', async () => {
    let called = false;
    const router = new RouterService({
      model: { providerRef: 'p', modelRef: 'router', decide: async () => { called = true; return { selectedAgentClassRef: null, rationale: 'none' }; } },
    });
    const result = await router.decide({ ...request, candidates: [] });
    expect(result.outcome).toBe('no_candidate');
    expect(called).toBe(false);
  });

  it('maps timeout and rejects unknown selections', async () => {
    const timeoutRouter = new RouterService({
      timeoutMs: 5,
      model: { providerRef: 'p', modelRef: 'router', decide: async () => new Promise(() => undefined) },
    });
    await expect(timeoutRouter.decide(request)).rejects.toMatchObject<RouterError>({ code: 'route_timeout' });
    const invalidRouter = new RouterService({
      model: { providerRef: 'p', modelRef: 'router', decide: async () => ({ selectedAgentClassRef: 'unknown', rationale: 'bad' }) },
    });
    await expect(invalidRouter.decide(request)).rejects.toMatchObject({ code: 'route_invalid_output' });
  });

  it('falls back to the default binding when the decision model is unavailable', async () => {
    const multiple = { ...request, candidates: [
      { agentClassRef: 'pi', providerRef: 'p', modelRef: 'm', permissionProfileRef: 'standard-agent' },
      { agentClassRef: 'pi', providerRef: 'p', modelRef: 'other', permissionProfileRef: 'standard-agent' },
    ], modelCatalog: [...request.modelCatalog, { providerRef: 'p', modelRef: 'other', modelId: 'other-model' }] };
    const router = new RouterService({
      model: { providerRef: 'metawork-router', modelRef: 'span-routing-v1', decide: async () => ({
        selectedAgentClassRef: null,
        rationale: 'Router decision unavailable (span_http_error); no route selected',
        unavailableReason: 'span_http_error',
      }) },
      createId: () => 'route-fallback', now: () => '2026-11-11T00:00:00.000Z',
    });
    const decision = await router.decide(multiple);
    expect(decision.outcome).toBe('selected');
    expect(decision.selection).toBe('default_fallback');
    expect(decision.unavailableReason).toBe('span_http_error');
    // The default is the first binding of the pinned candidate order and can
    // never be a binding the eligibility projection did not offer.
    expect(decision.selected).toEqual(multiple.candidates[0]);
    expect(decision.rationale).toBe(
      'Router decision unavailable (span_http_error); default binding selected pi/p/m');
  });

  it('keeps a declining decision model from stranding eligible candidates', async () => {
    const multiple = { ...request, candidates: [...request.candidates,
      { agentClassRef: 'pi', providerRef: 'p', modelRef: 'other', permissionProfileRef: 'standard-agent' }],
      modelCatalog: [...request.modelCatalog, { providerRef: 'p', modelRef: 'other', modelId: 'other-model' }] };
    const router = new RouterService({ model: { providerRef: 'p', modelRef: 'router',
      decide: async () => ({ selectedAgentClassRef: null, rationale: 'declined' }) } });
    await expect(router.decide(multiple)).resolves.toMatchObject({
      outcome: 'selected', selection: 'default_fallback', unavailableReason: 'decision_model_unavailable',
    });
  });

  it('reports the same selection source after a persisted decision is replayed', async () => {
    const db = new Database(':memory:');
    try {
      const multiple = { ...request, candidates: [...request.candidates,
        { agentClassRef: 'pi', providerRef: 'p', modelRef: 'other', permissionProfileRef: 'standard-agent' }],
        modelCatalog: [...request.modelCatalog, { providerRef: 'p', modelRef: 'other', modelId: 'other-model' }] };
      const decisions = new RouteDecisionRepo(db);
      const router = new RouterService({ model: { providerRef: 'metawork-router', modelRef: 'span-routing-v1',
        decide: async () => ({ selectedAgentClassRef: null, rationale: 'down', unavailableReason: 'span_http_error' }) } });
      const live = await router.decide(multiple);
      expect(decisions.record(multiple, live)).toBe('inserted');
      const replayed = decisions.findByAttempt(multiple.taskId, multiple.generationId, multiple.subtaskId, multiple.attemptOrdinal);
      expect(replayed).toMatchObject({
        outcome: 'selected',
        selection: 'default_fallback',
        unavailableReason: 'span_http_error',
        selected: live.selected,
      });
    } finally { db.close(); }
  });

  it('never calls the model with an excluded Agent or an unknown Provider/model binding', async () => {
    let calls = 0;
    const router = new RouterService({ model: { providerRef: 'p', modelRef: 'router', decide: async () => {
      calls++;
      return { selectedAgentClassRef: 'pi', rationale: 'fit' };
    } } });
    await expect(router.decide({ ...request, excluded: [{ agentClassRef: 'pi', reason: 'disabled' }] }))
      .rejects.toMatchObject({ code: 'route_invalid_input' });
    await expect(router.decide({ ...request, modelCatalog: [] }))
      .rejects.toMatchObject({ code: 'route_invalid_input' });
    expect(calls).toBe(0);
  });
});
