import type {
  SpanRoutingEvaluator,
  SpanSubtaskEvaluationRequest,
} from '../../src/routing/span-routing-types.js';

/**
 * Test-only Router decision adapter.
 *
 * Production routes through the Server Span advisor; a test that is not about
 * routing must still state which eligible binding it expects, because the Task
 * Runtime never falls back to a default model (ADR-0055 D1). By default the
 * adapter advises the first candidate of the already-authorized set.
 */
export function scriptedRouterEvaluator(
  choose: (request: SpanSubtaskEvaluationRequest) => number = () => 0,
): SpanRoutingEvaluator & { calls: SpanSubtaskEvaluationRequest[] } {
  const calls: SpanSubtaskEvaluationRequest[] = [];
  return {
    calls,
    async evaluate(input: { requests: readonly SpanSubtaskEvaluationRequest[] }) {
      return {
        subtasks: input.requests.map(request => {
          calls.push(request);
          const bindings = request.request.candidates;
          const chosen = Math.min(Math.max(choose(request), 0), Math.max(bindings.length - 1, 0));
          return {
            subtaskId: request.subtaskId,
            candidateSetFingerprint: request.candidateSetFingerprint,
            status: 'advised' as const,
            resolvedModel: 'test/router-fixture',
            candidates: bindings.map((binding, index) => ({
              candidateId: binding.questionId,
              agentClassRef: binding.agentClassRef,
              providerRef: binding.providerRef,
              modelRef: binding.modelRef,
              probability: index === chosen ? 1 : 0,
            })),
          };
        }),
      };
    },
  };
}
