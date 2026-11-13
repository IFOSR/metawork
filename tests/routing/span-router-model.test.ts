import { describe, expect, it, vi } from 'vitest';
import { SpanRouterModel } from '../../src/routing/span-router-model.js';
import type { RouteRequest } from '../../src/routing/router.js';
import type { SpanRoutingEvaluator } from '../../src/routing/span-routing-types.js';

const request: RouteRequest = {
  taskId: 'task-1',
  generationId: 'generation-1',
  subtaskId: 'subtask-1',
  graphRevision: 2,
  attemptOrdinal: 1,
  goal: 'produce the requested report',
  acceptance: ['report exists'],
  configurationRevision: 'config-1',
  candidates: [
    { agentClassRef: 'executor-a', providerRef: 'provider-a', modelRef: 'model-a', permissionProfileRef: 'profile-a' },
    { agentClassRef: 'executor-b', providerRef: 'provider-b', modelRef: 'model-b', permissionProfileRef: 'profile-b' },
  ],
  excluded: [],
  modelCatalog: [
    { providerRef: 'provider-a', modelRef: 'model-a', modelId: 'model-a' },
    { providerRef: 'provider-b', modelRef: 'model-b', modelId: 'model-b' },
  ],
};

describe('SpanRouterModel', () => {
  it('selects the exact binding with the highest advised probability', async () => {
    const evaluate = vi.fn<SpanRoutingEvaluator['evaluate']>(async input => ({
      subtasks: [{
        subtaskId: input.requests[0]!.subtaskId,
        candidateSetFingerprint: input.requests[0]!.candidateSetFingerprint,
        status: 'advised',
        resolvedModel: 'jev-v1',
        candidates: [
          { candidateId: 'c000', agentClassRef: 'executor-a', providerRef: 'provider-a', modelRef: 'model-a', probability: 0.2 },
          { candidateId: 'c001', agentClassRef: 'executor-b', providerRef: 'provider-b', modelRef: 'model-b', probability: 0.8 },
        ],
      }],
    }));
    const model = new SpanRouterModel({ evaluator: { evaluate } });

    await expect(model.decide(request, new AbortController().signal)).resolves.toMatchObject({
      selectedAgentClassRef: 'executor-b',
      selectedProviderRef: 'provider-b',
      selectedModelRef: 'model-b',
    });
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      configurationRevision: 'config-1',
      requests: [expect.objectContaining({
        subtaskId: 'subtask-1',
        request: expect.objectContaining({
          candidates: expect.arrayContaining([
            expect.objectContaining({ agentClassRef: 'executor-a' }),
            expect.objectContaining({ agentClassRef: 'executor-b' }),
          ]),
        }),
      })],
    }));
  });

  it('returns no-candidate when the evaluator cannot advise', async () => {
    const model = new SpanRouterModel({
      evaluator: {
        evaluate: async input => ({
          subtasks: [{
            subtaskId: input.requests[0]!.subtaskId,
            candidateSetFingerprint: input.requests[0]!.candidateSetFingerprint,
            status: 'fallback',
            reason: 'span_timeout',
          }],
        }),
      },
    });

    await expect(model.decide(request, new AbortController().signal)).resolves.toMatchObject({
      selectedAgentClassRef: null,
      rationale: expect.stringContaining('no route selected'),
    });
  });

  it('redacts task secrets before sending state to the decision model', async () => {
    let observedGoal = '';
    const model = new SpanRouterModel({
      evaluator: {
        evaluate: async input => {
          observedGoal = String((input.requests[0]!.request.state.subtask as { goal: string }).goal);
          return {
            subtasks: [{
              subtaskId: input.requests[0]!.subtaskId,
              candidateSetFingerprint: input.requests[0]!.candidateSetFingerprint,
              status: 'fallback',
              reason: 'span_http_error',
            }],
          };
        },
      },
    });
    await model.decide({ ...request, goal: 'use apiKey=secret-value to produce the report' }, new AbortController().signal);
    expect(observedGoal).toContain('apiKey=[REDACTED]');
    expect(observedGoal).not.toContain('secret-value');
  });
});
