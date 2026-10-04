import {
  SPAN_MODEL,
  type SpanEvaluationRequest,
  type SpanUsage,
} from './span-routing-types.js';

/** OpenRouter reports either the public free alias or a dated snapshot. */
const SPAN_MODEL_VERSION = /^inception\/mercury-decide(?::free|-\d{8})?$/u;

export type SpanResponseValidationResult =
  | {
      ok: true;
      /** Actual dated snapshot that served the request, when reported. */
      resolvedModel: string;
      probabilities: Record<string, number>;
      usage?: SpanUsage;
    }
  | { ok: false; reason: 'span_invalid_response' | 'span_candidate_mismatch' };

/**
 * Validates a joint choice response against the exact candidate set that was sent.
 *
 * A partial answer is never accepted: a missing, unknown, mistyped, or
 * out-of-range probability fails the whole Subtask so the Kernel can fall back
 * to the deterministic comparator instead of ranking on incomplete data.
 */
export function validateSpanDecisionsResponse(input: {
  request: SpanEvaluationRequest;
  response: unknown;
}): SpanResponseValidationResult {
  const response = asRecord(input.response);
  if (!response) return { ok: false, reason: 'span_invalid_response' };
  const model = response.model;
  if (typeof model !== 'string' || !SPAN_MODEL_VERSION.test(model)) {
    return { ok: false, reason: 'span_invalid_response' };
  }
  const answers = asRecord(response.answers);
  if (!answers) return { ok: false, reason: 'span_invalid_response' };

  const expected = Object.keys(input.request.questions);
  const received = Object.keys(answers);
  if (
    received.length !== expected.length
    || expected.some(questionId => !Object.hasOwn(answers, questionId))
  ) {
    return { ok: false, reason: 'span_candidate_mismatch' };
  }

  const probabilities: Record<string, number> = {};
  for (const questionId of expected) {
    const answer = asRecord(answers[questionId]);
    if (!answer || answer.type !== 'choice') {
      return { ok: false, reason: 'span_invalid_response' };
    }
    const candidateIds = input.request.candidates.map(candidate => candidate.questionId);
    if (typeof answer.choice !== 'string' || !candidateIds.includes(answer.choice)) {
      return { ok: false, reason: 'span_candidate_mismatch' };
    }
    const answerProbabilities = asRecord(answer.probabilities);
    if (!answerProbabilities) return { ok: false, reason: 'span_invalid_response' };
    const receivedCandidateIds = Object.keys(answerProbabilities);
    if (
      receivedCandidateIds.length !== candidateIds.length
      || candidateIds.some(candidateId => !Object.hasOwn(answerProbabilities, candidateId))
    ) {
      return { ok: false, reason: 'span_candidate_mismatch' };
    }
    for (const candidateId of candidateIds) {
      const probability = answerProbabilities[candidateId];
      if (
        typeof probability !== 'number'
        || !Number.isFinite(probability)
        || probability < 0
        || probability > 1
      ) {
        return { ok: false, reason: 'span_invalid_response' };
      }
      probabilities[candidateId] = probability;
    }
  }

  let usage: SpanUsage | undefined;
  if (response.usage !== undefined) {
    const parsed = parseUsage(response.usage);
    if (!parsed) return { ok: false, reason: 'span_invalid_response' };
    usage = parsed;
  }

  return {
    ok: true,
    resolvedModel: model === SPAN_MODEL ? SPAN_MODEL : model,
    probabilities,
    ...(usage ? { usage } : {}),
  };
}

function parseUsage(value: unknown): SpanUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const usage: SpanUsage = {};
  for (const [field, key] of [
    ['inputTokens', 'inputTokens'],
    ['outputTokens', 'outputTokens'],
    ['cost', 'cost'],
  ] as const) {
    const raw = record[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1_000_000_000) {
      return undefined;
    }
    usage[key] = raw;
  }
  return usage;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
