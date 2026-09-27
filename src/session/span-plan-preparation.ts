import type {
  KernelConfigurationView,
  RuntimeConfigurationView,
} from '../configuration/types.js';
import type { KernelEvent } from '../kernel/control-kernel.js';
import { unavailableAgentClasses } from '../kernel/plan-routing-eligibility.js';
import {
  planProposalFingerprint,
  planRoutingCandidateSetFingerprint,
  planSubtaskCandidateGroups,
} from '../routing/plan-routing-candidates.js';
import { buildSpanSubtaskEvaluationRequest } from '../routing/span-question-builder.js';
import {
  SPAN_MAX_CANDIDATES_PER_PROPOSAL,
  SPAN_MAX_EVALUATED_SUBTASKS,
  SPAN_MAX_OBSERVATION_BYTES,
  SPAN_OBSERVATION_POLICY_VERSION,
  SPAN_OBSERVATION_SCHEMA_VERSION,
  SPAN_QUESTION_VERSION,
  SPAN_MODEL,
  type SpanFallbackReason,
  type SpanRoutingEvaluator,
  type SpanRoutingObservation,
  type SpanSubtaskEvaluationRequest,
  type SpanSubtaskObservation,
} from '../routing/span-routing-types.js';

export type PlanProposedEvent = Extract<KernelEvent, { type: 'plan_proposed' }>;

export interface PrepareSpanRoutingInput {
  event: PlanProposedEvent;
  configuration: KernelConfigurationView;
  executorStatuses: Parameters<typeof unavailableAgentClasses>[0];
  runtimeConfiguration: RuntimeConfigurationView | null;
  evaluator: SpanRoutingEvaluator | null;
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * Builds, validates, and attaches the bounded Span observation for one
 * `plan_proposed` event.
 *
 * Returns the original event unchanged whenever Span is disabled, the proposal
 * is not a work graph, no advisor is configured, or the observation would
 * exceed its byte budget. It performs no durable write: the caller submits the
 * enriched event through the normal Kernel inbox, so replay of an already
 * stored event never calls the API again.
 */
export async function attachSpanRoutingObservation(
  input: PrepareSpanRoutingInput,
): Promise<PlanProposedEvent> {
  const now = input.now ?? (() => Date.now());
  const { event } = input;
  if (!input.evaluator) return event;
  const proposal = event.proposal;
  if (proposal.action !== 'plan_work_graph' || !proposal.workGraph) return event;
  const spanConfig = input.runtimeConfiguration?.routing?.span;
  if (!spanConfig?.enabled) return event;

  const unavailable = unavailableAgentClasses(input.executorStatuses, event.occurredAt);
  const deadLine = now() + spanConfig.timeoutMs;
  const requests: SpanSubtaskEvaluationRequest[] = [];
  const skippedOrFailed: SpanSubtaskObservation[] = [];
  let candidateBudget = 0;

  for (const subtask of proposal.workGraph.subtasks) {
    if (requests.length + skippedOrFailed.length >= SPAN_MAX_EVALUATED_SUBTASKS) {
      skippedOrFailed.push({ subtaskId: subtask.id, status: 'skipped', reason: 'single_candidate' });
      continue;
    }
    const groups = planSubtaskCandidateGroups({
      configuration: input.configuration,
      subtask,
      unavailableAgentClasses: unavailable,
    });
    const candidateSetFingerprint = planRoutingCandidateSetFingerprint(
      groups.flatMap(group => group.eligible.map(candidate => ({
        agentClassRef: group.agentClassRef,
        providerRef: candidate.providerRef,
        modelRef: candidate.modelRef,
      }))),
    );
    const eligibleCount = groups.reduce((total, group) => total + group.eligible.length, 0);
    if (eligibleCount === 0) {
      skippedOrFailed.push({ subtaskId: subtask.id, status: 'skipped', reason: 'no_eligible_candidate' });
      continue;
    }
    if (eligibleCount === 1) {
      skippedOrFailed.push({ subtaskId: subtask.id, status: 'skipped', reason: 'single_candidate' });
      continue;
    }
    if (candidateBudget + eligibleCount > SPAN_MAX_CANDIDATES_PER_PROPOSAL) {
      skippedOrFailed.push({
        subtaskId: subtask.id,
        candidateSetFingerprint,
        status: 'fallback',
        reason: 'span_proposal_budget_exhausted' satisfies SpanFallbackReason,
      });
      continue;
    }
    const built = buildSpanSubtaskEvaluationRequest({
      subtask,
      groups,
      agentClasses: input.configuration.agentClasses,
    });
    if (!built.ok) {
      skippedOrFailed.push(built.reason === 'no_eligible_candidate'
        ? { subtaskId: subtask.id, status: 'skipped', reason: 'no_eligible_candidate' }
        : {
            subtaskId: subtask.id,
            candidateSetFingerprint,
            status: 'fallback',
            reason: 'span_input_too_large',
          });
      continue;
    }
    candidateBudget += eligibleCount;
    requests.push({ subtaskId: subtask.id, candidateSetFingerprint, request: built.request });
  }

  let evaluated: SpanSubtaskObservation[] = [];
  let usage: SpanRoutingObservation['usage'];
  if (requests.length > 0) {
    const result = await input.evaluator.evaluate({
      deadlineMs: deadLine,
      ...(input.signal ? { signal: input.signal } : {}),
      requests,
    });
    evaluated = requests.map(request => result.subtasks.find(
      subtask => subtask.subtaskId === request.subtaskId,
    ) ?? {
      subtaskId: request.subtaskId,
      candidateSetFingerprint: request.candidateSetFingerprint,
      status: 'fallback' as const,
      reason: 'span_invalid_response' as const,
    });
    usage = result.usage;
  }

  const subtasks = orderSubtasks(
    proposal.workGraph.subtasks.map(subtask => subtask.id),
    [...evaluated, ...skippedOrFailed],
  );
  const observation: SpanRoutingObservation = {
    schemaVersion: SPAN_OBSERVATION_SCHEMA_VERSION,
    policyVersion: SPAN_OBSERVATION_POLICY_VERSION,
    questionVersion: SPAN_QUESTION_VERSION,
    model: SPAN_MODEL,
    eventId: event.id,
    proposalFingerprint: planProposalFingerprint({
      task: proposal.task,
      workGraph: proposal.workGraph,
    }),
    configurationRevision: event.configurationRevision,
    generationId: event.generationId,
    targetGraphRevision: event.targetGraphRevision,
    subtasks,
    ...(usage ? { usage } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(observation), 'utf8') > SPAN_MAX_OBSERVATION_BYTES) {
    return event;
  }
  return { ...event, spanRouting: observation };
}

function orderSubtasks(
  subtaskIds: readonly string[],
  observations: readonly SpanSubtaskObservation[],
): SpanSubtaskObservation[] {
  const byId = new Map(observations.map(item => [item.subtaskId, item]));
  return subtaskIds
    .map(id => byId.get(id))
    .filter((item): item is SpanSubtaskObservation => Boolean(item));
}
