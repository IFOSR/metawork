import type { KernelConfigurationView } from '../configuration/types.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import type { WorkGraphSubtask } from '../work-graph/types.js';
import type { PlanSubtaskCandidateGroup } from './plan-routing-candidates.js';
import { planRoutingCandidateId } from './plan-routing-candidates.js';
import {
  SPAN_MAX_CANDIDATES_PER_SUBTASK,
  SPAN_MAX_REQUEST_BYTES,
  SPAN_MODEL,
  type SpanCandidateBinding,
  type SpanEvaluationRequest,
  type SpanNoulQuestion,
} from './span-routing-types.js';

const TITLE_LIMIT = 200;
const GOAL_LIMIT = 1_200;
const ACCEPTANCE_ITEMS_LIMIT = 8;
const ACCEPTANCE_TEXT_LIMIT = 200;
const CAPABILITY_LIMIT = 16;

export type SpanQuestionBuildResult =
  | { ok: true; request: SpanEvaluationRequest }
  | { ok: false; reason: 'no_eligible_candidate' | 'span_input_too_large' };

/**
 * Builds one bounded `noul` batch for a single Subtask.
 *
 * Only hard-eligible candidates that already passed the shared filter are
 * described. Candidate identity is sorted canonically before question ids are
 * assigned so a shuffled input cannot change the id -> identity mapping.
 * Task text is treated as data and redacted; it is never interpolated into an
 * instruction that could reference candidates or permissions.
 */
export function buildSpanSubtaskEvaluationRequest(input: {
  subtask: WorkGraphSubtask;
  groups: readonly PlanSubtaskCandidateGroup[];
  agentClasses: KernelConfigurationView['agentClasses'];
  maxCandidates?: number;
}): SpanQuestionBuildResult {
  const maxCandidates = input.maxCandidates ?? SPAN_MAX_CANDIDATES_PER_SUBTASK;
  const entries = input.groups
    .flatMap(group => group.eligible.map(candidate => ({
      agentClassRef: group.agentClassRef,
      providerRef: candidate.providerRef,
      modelRef: candidate.modelRef,
      modelId: candidate.modelId,
      capabilities: candidate.capabilities,
      qualityTier: candidate.qualityTier,
      latencyTier: candidate.latencyTier,
    })))
    .sort((left, right) => (
      left.agentClassRef.localeCompare(right.agentClassRef)
      || left.providerRef.localeCompare(right.providerRef)
      || left.modelRef.localeCompare(right.modelRef)
    ));
  if (entries.length === 0) return { ok: false, reason: 'no_eligible_candidate' };
  if (entries.length > maxCandidates) return { ok: false, reason: 'span_input_too_large' };

  const candidates: SpanCandidateBinding[] = [];
  const stateCandidates: Record<string, unknown> = {};
  const questions: Record<string, SpanNoulQuestion> = {};
  entries.forEach((entry, index) => {
    const questionId = `c${String(index).padStart(3, '0')}`;
    const candidateId = planRoutingCandidateId({
      agentClassRef: entry.agentClassRef,
      providerRef: entry.providerRef,
      modelRef: entry.modelRef,
    });
    candidates.push({
      questionId,
      candidateId,
      agentClassRef: entry.agentClassRef,
      providerRef: entry.providerRef,
      modelRef: entry.modelRef,
    });
    const agentClass = input.agentClasses[entry.agentClassRef];
    stateCandidates[questionId] = {
      agentClass: entry.agentClassRef,
      model: entry.modelRef,
      capabilities: [...entry.capabilities].sort().slice(0, CAPABILITY_LIMIT),
      ...(entry.qualityTier ? { qualityTier: entry.qualityTier } : {}),
      ...(entry.latencyTier ? { latencyTier: entry.latencyTier } : {}),
      routingCapabilities: [...(agentClass?.routingCapabilities ?? [])].sort(),
    };
    questions[questionId] = {
      type: 'noul',
      instructions:
        `Evaluate state.candidates.${questionId} against state.subtask requirements. `
        + 'The candidate is exactly the AgentClass and model named there.',
      criteria: {
        true: 'The named candidate is well suited to perform the described subtask.',
        false: 'The named candidate is poorly suited to perform the described subtask.',
      },
    };
  });

  const request: SpanEvaluationRequest = {
    model: SPAN_MODEL,
    state: {
      subtask: {
        title: bound(redactSensitiveText(input.subtask.title), TITLE_LIMIT),
        goal: bound(redactSensitiveText(input.subtask.goal), GOAL_LIMIT),
        requiredCapabilities: [...input.subtask.requiredCapabilities].sort(),
        riskLevel: input.subtask.riskLevel,
        acceptance: input.subtask.acceptance
          .slice(0, ACCEPTANCE_ITEMS_LIMIT)
          .map(item => ({
            key: bound(item.key, 64),
            description: bound(redactSensitiveText(item.description), ACCEPTANCE_TEXT_LIMIT),
          })),
      },
      candidates: stateCandidates,
    },
    questions,
    candidates,
  };
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > SPAN_MAX_REQUEST_BYTES) {
    return { ok: false, reason: 'span_input_too_large' };
  }
  return { ok: true, request };
}

function bound(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
