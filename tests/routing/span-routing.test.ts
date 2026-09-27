import { describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
import {
  buildSpanSubtaskEvaluationRequest,
} from '../../src/routing/span-question-builder.js';
import {
  validateSpanDecisionsResponse,
} from '../../src/routing/span-response-validator.js';
import {
  SpanEvaluationAbortedError,
  SpanRoutingAdvisor,
  type SpanDecisionClient,
} from '../../src/routing/span-routing-advisor.js';
import type { PlanSubtaskCandidateGroup } from '../../src/routing/plan-routing-candidates.js';
import type { KernelConfigurationView } from '../../src/configuration/types.js';
import type { WorkGraphSubtask } from '../../src/work-graph/types.js';
import type { SpanEvaluationRequest } from '../../src/routing/span-routing-types.js';

function agentClasses(): KernelConfigurationView['agentClasses'] {
  return {
    'codex-fast': {
      kind: 'executor',
      harnessRef: 'codex',
      driverId: 'codex-cli',
      modelPolicy: { mode: 'auto', allowedModelRefs: ['model-fast'] },
      permissionProfileRef: 'workspace',
      routingCapabilities: ['workspace-engineering'],
      enabled: true,
      transport: 'local-cli',
      supportsProbe: true,
      supportsAbort: true,
      supportsContinuation: true,
    },
    'pi-general': {
      kind: 'executor',
      harnessRef: 'pi',
      driverId: 'pi-cli',
      modelPolicy: { mode: 'auto', allowedModelRefs: ['model-deep'] },
      permissionProfileRef: 'workspace',
      routingCapabilities: ['workspace-research'],
      enabled: true,
      transport: 'local-cli',
      supportsProbe: true,
      supportsAbort: true,
      supportsContinuation: true,
    },
  };
}

function groups(): PlanSubtaskCandidateGroup[] {
  return [
    {
      agentClassRef: 'pi-general',
      bindingIndex: 1,
      harnessRef: 'pi',
      permissionProfileRef: 'workspace',
      eligible: [{
        providerRef: 'provider-a',
        modelRef: 'model-deep',
        modelId: 'gpt-deep',
        capabilities: ['coding', 'long-context'],
        qualityTier: 'high',
        latencyTier: 'medium',
        health: 'healthy',
        available: true,
      }],
      rejected: [],
    },
    {
      agentClassRef: 'codex-fast',
      bindingIndex: 0,
      harnessRef: 'codex',
      permissionProfileRef: 'workspace',
      eligible: [{
        providerRef: 'provider-a',
        modelRef: 'model-fast',
        modelId: 'gpt-fast',
        capabilities: ['coding', 'tools'],
        qualityTier: 'medium',
        latencyTier: 'low',
        health: 'healthy',
        available: true,
      }],
      rejected: [],
    },
  ];
}

function subtask(overrides: Partial<WorkGraphSubtask> = {}): WorkGraphSubtask {
  return {
    id: 'subtask-1',
    title: 'Implement auth flow',
    goal: 'Implement the authentication flow. api_key=sk-should-be-redacted',
    dependencies: [],
    contextRefs: [],
    requiredCapabilities: [],
    executorBindings: [],
    deliveryKind: 'edit',
    acceptance: [{ key: 'tests', description: 'Unit tests pass', requiredEvidence: ['x'] }],
    riskLevel: 'medium',
    ...overrides,
  };
}

function buildRequest(): SpanEvaluationRequest {
  const built = buildSpanSubtaskEvaluationRequest({
    subtask: subtask(),
    groups: groups(),
    agentClasses: agentClasses(),
  });
  if (!built.ok) throw new Error(`unexpected build failure: ${built.reason}`);
  return built.request;
}

describe('Span question builder', () => {
  it('assigns canonical question ids independently of group order', () => {
    const forward = buildSpanSubtaskEvaluationRequest({
      subtask: subtask(), groups: groups(), agentClasses: agentClasses(),
    });
    const reversed = buildSpanSubtaskEvaluationRequest({
      subtask: subtask(), groups: [...groups()].reverse(), agentClasses: agentClasses(),
    });
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    expect(forward.request.candidates).toEqual(reversed.request.candidates);
    expect(forward.request.candidates.map(item => item.questionId)).toEqual(['c000', 'c001']);
  });

  it('names the exact candidate in each instruction', () => {
    const request = buildRequest();
    expect(request.questions.c000!.instructions).toContain('state.candidates.c000');
    expect(request.questions.c001!.instructions).toContain('state.candidates.c001');
    expect(request.questions.c000!.type).toBe('noul');
  });

  it('redacts credential-like text and never includes unrelated task data', () => {
    const request = buildRequest();
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain('sk-should-be-redacted');
    expect(request.state.subtask).toMatchObject({
      title: 'Implement auth flow',
      riskLevel: 'medium',
    });
  });

  it('fails closed instead of truncating when the candidate batch is too large', () => {
    const many: PlanSubtaskCandidateGroup[] = [{
      agentClassRef: 'codex-fast',
      bindingIndex: 0,
      harnessRef: 'codex',
      permissionProfileRef: 'workspace',
      eligible: Array.from({ length: 33 }, (_, index) => ({
        providerRef: 'provider-a',
        modelRef: `model-${String(index).padStart(2, '0')}`,
        modelId: `gpt-${index}`,
        capabilities: ['coding'],
        health: 'healthy' as const,
        available: true,
      })),
      rejected: [],
    }];
    const built = buildSpanSubtaskEvaluationRequest({
      subtask: subtask(), groups: many, agentClasses: agentClasses(),
    });
    expect(built).toEqual({ ok: false, reason: 'span_input_too_large' });
  });

  it('sends the real model identity and the pinned model facts, not only opaque refs', () => {
    const built = buildSpanSubtaskEvaluationRequest({
      subtask: subtask(),
      groups: groups(),
      agentClasses: agentClasses(),
      models: {
        'model-fast': {
          providerRef: 'provider-a', modelId: 'gpt-fast', capabilities: ['coding', 'tools'],
          reasoning: 'low', contextLimit: 128_000, costTier: 'low', latencyTier: 'low',
          qualityTier: 'medium', enabled: true,
        },
      } as never,
    });
    if (!built.ok) throw new Error(`unexpected build failure: ${built.reason}`);
    // c000 sorts first by AgentClass ref (`codex-fast`).
    expect(built.request.state.candidates).toMatchObject({
      c000: {
        model: 'model-fast',
        modelId: 'gpt-fast',
        reasoning: 'low',
        costTier: 'low',
        contextLimit: 128_000,
      },
    });
  });

  it('changes the request when only the real model identity changes', () => {
    const withModelId = (modelId: string) => {
      const varied = groups().map(group => ({
        ...group,
        eligible: group.eligible.map(candidate => ({ ...candidate, modelId })),
      }));
      return buildSpanSubtaskEvaluationRequest({
        subtask: subtask(),
        groups: varied,
        agentClasses: agentClasses(),
      });
    };
    expect(withModelId('gpt-fast')).not.toEqual(withModelId('gpt-other-actual-model'));
  });

  it('reports no eligible candidate when every group is empty', () => {
    const built = buildSpanSubtaskEvaluationRequest({
      subtask: subtask(),
      groups: [{ agentClassRef: 'codex-fast', bindingIndex: 0, harnessRef: 'codex', permissionProfileRef: 'workspace', eligible: [], rejected: [] }],
      agentClasses: agentClasses(),
    });
    expect(built).toEqual({ ok: false, reason: 'no_eligible_candidate' });
  });
});

describe('Span response validator', () => {
  const request = buildRequest();

  it('accepts the real dated-snapshot response shape', () => {
    const result = validateSpanDecisionsResponse({
      request,
      response: {
        id: 'gen-dec-1',
        model: 'respan/span-01-lite-20260925',
        provider: 'TypeSafe',
        answers: {
          c000: { type: 'noul', noul: 0.88062555 },
          c001: { type: 'noul', noul: 0.629785 },
        },
        usage: { inputTokens: 476, outputTokens: 70, cost: 0.000019992 },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolvedModel).toBe('respan/span-01-lite-20260925');
    expect(result.probabilities).toEqual({ c000: 0.88062555, c001: 0.629785 });
    expect(result.usage?.inputTokens).toBe(476);
  });

  it.each([
    ['missing answer', { c000: { type: 'noul', noul: 0.5 } }],
    ['unknown answer', { c000: { type: 'noul', noul: 0.5 }, c001: { type: 'noul', noul: 0.5 }, c002: { type: 'noul', noul: 0.5 } }],
  ])('rejects a %s as a candidate mismatch', (_label, answers) => {
    const result = validateSpanDecisionsResponse({
      request,
      response: { model: 'respan/span-01-lite-20260925', answers, usage: { inputTokens: 1, outputTokens: 0 } },
    });
    expect(result).toEqual({ ok: false, reason: 'span_candidate_mismatch' });
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['out of range', 1.5],
    ['negative', -0.1],
    ['non numeric', 'high'],
  ])('rejects a %s probability', (_label, noul) => {
    const result = validateSpanDecisionsResponse({
      request,
      response: {
        model: 'respan/span-01-lite-20260925',
        answers: { c000: { type: 'noul', noul }, c001: { type: 'noul', noul: 0.5 } },
        usage: { inputTokens: 1, outputTokens: 0 },
      },
    });
    expect(result).toEqual({ ok: false, reason: 'span_invalid_response' });
  });

  it('rejects an unsupported primitive type', () => {
    const result = validateSpanDecisionsResponse({
      request,
      response: {
        model: 'respan/span-01-lite-20260925',
        answers: {
          c000: { type: 'choice', choice: 'a', probabilities: {} },
          c001: { type: 'noul', noul: 0.5 },
        },
        usage: { inputTokens: 1, outputTokens: 0 },
      },
    });
    expect(result).toEqual({ ok: false, reason: 'span_invalid_response' });
  });

  it('rejects an unexpected model identity', () => {
    const result = validateSpanDecisionsResponse({
      request,
      response: {
        model: 'openai/gpt-4o',
        answers: { c000: { type: 'noul', noul: 0.5 }, c001: { type: 'noul', noul: 0.5 } },
        usage: { inputTokens: 1, outputTokens: 0 },
      },
    });
    expect(result).toEqual({ ok: false, reason: 'span_invalid_response' });
  });
});

describe('Span routing advisor', () => {
  function advisor(client: SpanDecisionClient, apiKey: string | null = 'sk-or-test') {
    return new SpanRoutingAdvisor({
      resolveApiKey: async () => apiKey,
      createClient: () => client,
    });
  }

  function request(overrides: Partial<SpanEvaluationRequest> = {}) {
    return {
      subtaskId: 'subtask-1',
      candidateSetFingerprint: 'fingerprint-1',
      request: { ...buildRequest(), ...overrides },
    };
  }

  it('maps validated probabilities back to candidate identities', async () => {
    const client: SpanDecisionClient = {
      create: async () => ({
        model: 'respan/span-01-lite-20260925',
        answers: { c000: { type: 'noul', noul: 0.9 }, c001: { type: 'noul', noul: 0.2 } },
        usage: { inputTokens: 10, outputTokens: 0, cost: 0 },
      }),
    };
    const result = await advisor(client).evaluate({
      configurationRevision: 'revision-1',
      deadlineMs: Date.now() + 3_000,
      requests: [request()],
    });
    const observation = result.subtasks[0]!;
    expect(observation.status).toBe('advised');
    if (observation.status !== 'advised') return;
    expect(observation.candidates).toEqual([
      { candidateId: 'c000', agentClassRef: 'codex-fast', providerRef: 'provider-a', modelRef: 'model-fast', probability: 0.9 },
      { candidateId: 'c001', agentClassRef: 'pi-general', providerRef: 'provider-a', modelRef: 'model-deep', probability: 0.2 },
    ]);
    expect(observation.resolvedModel).toBe('respan/span-01-lite-20260925');
  });

  it('falls back without calling the API when no credential is available', async () => {
    const create = vi.fn();
    const result = await advisor({ create }, null).evaluate({
      configurationRevision: 'revision-1',
      deadlineMs: Date.now() + 3_000,
      requests: [request()],
    });
    expect(create).not.toHaveBeenCalled();
    expect(result.subtasks[0]).toMatchObject({ status: 'fallback', reason: 'span_secret_unavailable' });
  });

  it('aborts a hung request on timeout and reports span_timeout', async () => {
    const client: SpanDecisionClient = {
      create: (_request, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    };
    const result = await advisor(client).evaluate({
      configurationRevision: 'revision-1',
      deadlineMs: Date.now() + 40,
      requests: [request()],
    });
    expect(result.subtasks[0]).toMatchObject({ status: 'fallback', reason: 'span_timeout' });
  });

  it('reports span_http_error for a provider failure and never leaks the raw body', async () => {
    const client: SpanDecisionClient = {
      create: async () => {
        throw new Error('401 unauthorized: secret body');
      },
    };
    const result = await advisor(client).evaluate({
      configurationRevision: 'revision-1',
      deadlineMs: Date.now() + 3_000,
      requests: [request()],
    });
    expect(result.subtasks[0]).toMatchObject({ status: 'fallback', reason: 'span_http_error' });
    expect(JSON.stringify(result)).not.toContain('secret body');
  });

  it('reports span_invalid_response for an unparseable payload', async () => {
    const client: SpanDecisionClient = {
      create: async () => ({ model: 'respan/span-01-lite-20260925', answers: {} }),
    };
    const result = await advisor(client).evaluate({
      configurationRevision: 'revision-1',
      deadlineMs: Date.now() + 3_000,
      requests: [request()],
    });
    expect(result.subtasks[0]).toMatchObject({ status: 'fallback', reason: 'span_candidate_mismatch' });
  });

  it('keeps request cancellation distinct from a scored fallback', async () => {
    const controller = new AbortController();
    const client: SpanDecisionClient = {
      create: (_request, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    };
    const evaluation = advisor(client).evaluate({
      configurationRevision: 'revision-1',
      deadlineMs: Date.now() + 5_000,
      signal: controller.signal,
      requests: [request()],
    });
    controller.abort();
    await expect(evaluation).rejects.toBeInstanceOf(SpanEvaluationAbortedError);
  });

  it('caps concurrent requests', async () => {    let active = 0;
    let peak = 0;
    const client: SpanDecisionClient = {
      create: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
        return {
          model: 'respan/span-01-lite-20260925',
          answers: { c000: { type: 'noul', noul: 0.5 }, c001: { type: 'noul', noul: 0.5 } },
          usage: { inputTokens: 1, outputTokens: 0 },
        };
      },
    };
    const requests = Array.from({ length: 6 }, (_, index) => ({
      ...request(),
      subtaskId: `subtask-${index}`,
    }));
    await advisor(client).evaluate({ configurationRevision: 'revision-1', deadlineMs: Date.now() + 3_000, requests });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('returns no subtask observations for an empty plan', async () => {
    const result = await advisor({ create: vi.fn() }).evaluate({
      configurationRevision: 'revision-1',
      deadlineMs: Date.now() + 3_000,
      requests: [],
    });
    expect(result.subtasks).toEqual([]);
  });

  it('bounds total concurrency across concurrent proposals on one Server advisor', async () => {
    const release = deferred<void>();
    let active = 0;
    let peak = 0;
    const instance = advisor({
      create: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await release.promise;
        active -= 1;
        return {
          model: 'respan/span-01-lite-20260925',
          answers: { c000: { type: 'noul', noul: 0.5 }, c001: { type: 'noul', noul: 0.5 } },
          usage: { inputTokens: 1, outputTokens: 0 },
        };
      },
    });
    const requests = [request('a'), request('b')];
    const proposals = [
      instance.evaluate({ configurationRevision: 'revision-1', deadlineMs: Date.now() + 3_000, requests }),
      instance.evaluate({ configurationRevision: 'revision-1', deadlineMs: Date.now() + 3_000, requests }),
    ];
    await vi.waitFor(() => expect(active).toBeGreaterThan(0));
    // Let the limiter hand out whatever slots it intends to hand out.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(peak).toBeLessThanOrEqual(2);
    release.resolve();
    await Promise.all(proposals);
  });

  it('resolves the credential for the pinned configuration revision', async () => {
    const resolveApiKey = vi.fn(async () => 'sk-or-test');
    const client: SpanDecisionClient = {
      create: async () => ({
        model: 'respan/span-01-lite-20260925',
        answers: { c000: { type: 'noul', noul: 0.9 }, c001: { type: 'noul', noul: 0.2 } },
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
    };
    const instance = new SpanRoutingAdvisor({ resolveApiKey, createClient: () => client });
    await instance.evaluate({
      configurationRevision: 'revision-pinned',
      deadlineMs: Date.now() + 3_000,
      requests: [request()],
    });
    expect(resolveApiKey).toHaveBeenCalledWith('revision-pinned');
  });

  it('reports a bounded fallback when credential resolution rejects', async () => {
    const instance = new SpanRoutingAdvisor({
      resolveApiKey: async () => { throw new Error('RAW provider body must not surface'); },
      createClient: () => ({ create: async () => ({}) }),
    });
    const result = await instance.evaluate({
      configurationRevision: 'revision-1',
      deadlineMs: Date.now() + 3_000,
      requests: [request()],
    });
    expect(result.subtasks[0]).toMatchObject({
      status: 'fallback',
      reason: 'span_secret_unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('RAW provider body');
  });

  it('bounds credential resolution by the proposal deadline', async () => {
    const release = deferred<string>();
    const instance = new SpanRoutingAdvisor({
      resolveApiKey: () => release.promise,
      createClient: () => ({ create: async () => ({}) }),
    });
    const result = await instance.evaluate({
      configurationRevision: 'revision-1',
      deadlineMs: Date.now() + 30,
      requests: [request()],
    });
    expect(result.subtasks[0]).toMatchObject({ status: 'fallback', reason: 'span_timeout' });
    release.resolve('sk-or-late');
  });

  it('propagates caller cancellation instead of scoring it', async () => {
    const release = deferred<string>();
    const instance = new SpanRoutingAdvisor({
      resolveApiKey: () => release.promise,
      createClient: () => ({ create: async () => ({}) }),
    });
    const controller = new AbortController();
    const evaluation = instance.evaluate({
      configurationRevision: 'revision-1',
      deadlineMs: Date.now() + 5_000,
      signal: controller.signal,
      requests: [request()],
    });
    controller.abort();
    await expect(evaluation).rejects.toBeInstanceOf(SpanEvaluationAbortedError);
    release.resolve('sk-or-late');
  });
});
