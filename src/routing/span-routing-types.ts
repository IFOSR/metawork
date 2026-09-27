/**
 * Bounded value types for the Span routing advisor (ADR-0033 amendment).
 *
 * These types are pure data. Kernel imports them, but the external adapter that
 * performs the network call lives in `span-routing-advisor.ts` and is never
 * reachable from `ControlKernel`.
 */

export const SPAN_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const SPAN_OBSERVATION_POLICY_VERSION = 'span-routing-v1' as const;
/**
 * Bumped when the bounded question/state payload changes. A Kernel-side mismatch
 * discards an older observation and keeps the deterministic resolver instead of
 * ranking on data produced under a different contract.
 */
export const SPAN_QUESTION_VERSION = 'span-fit-v2' as const;
export const SPAN_MODEL = 'respan/span-01-lite' as const;

/** Per-request and per-proposal limits (design §6). */
export const SPAN_MAX_CANDIDATES_PER_SUBTASK = 32;
export const SPAN_MAX_EVALUATED_SUBTASKS = 16;
export const SPAN_MAX_CANDIDATES_PER_PROPOSAL = 128;
export const SPAN_MAX_REQUEST_BYTES = 32 * 1024;
export const SPAN_MAX_OBSERVATION_BYTES = 128 * 1024;
export const SPAN_MAX_CONCURRENT_REQUESTS = 2;

/**
 * Finite, persistable failure vocabulary. Raw SDK error bodies are never
 * stored, logged, or returned to clients.
 */
export type SpanFallbackReason =
  | 'span_disabled'
  | 'span_secret_unavailable'
  | 'span_configuration_unavailable'
  | 'span_timeout'
  | 'span_http_error'
  | 'span_invalid_response'
  | 'span_candidate_mismatch'
  | 'span_input_too_large'
  | 'span_proposal_budget_exhausted';

export type SpanSkipReason =
  | 'span_disabled'
  | 'single_candidate'
  | 'no_eligible_candidate';

export interface SpanUsage {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export interface SpanRoutingCandidate {
  /** Stable question id used in the Span request (`c000`...). */
  candidateId: string;
  agentClassRef: string;
  providerRef: string;
  modelRef: string;
  probability: number;
}

export type SpanSubtaskObservation =
  | {
      subtaskId: string;
      candidateSetFingerprint: string;
      status: 'advised';
      resolvedModel: string;
      candidates: SpanRoutingCandidate[];
      usage?: SpanUsage;
      durationMs?: number;
    }
  | {
      subtaskId: string;
      candidateSetFingerprint: string;
      status: 'fallback';
      reason: SpanFallbackReason;
      durationMs?: number;
    }
  | {
      subtaskId: string;
      status: 'skipped';
      reason: SpanSkipReason;
    };

export interface SpanRoutingObservation {
  schemaVersion: typeof SPAN_OBSERVATION_SCHEMA_VERSION;
  policyVersion: typeof SPAN_OBSERVATION_POLICY_VERSION;
  questionVersion: typeof SPAN_QUESTION_VERSION;
  model: typeof SPAN_MODEL;
  eventId: string;
  proposalFingerprint: string;
  configurationRevision: string;
  generationId: string;
  targetGraphRevision: number;
  subtasks: SpanSubtaskObservation[];
  usage?: SpanUsage;
}

/** One `noul` question as accepted by the Decisions API. */
export interface SpanNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

/** Candidate identity bound to a stable question id. */
export interface SpanCandidateBinding {
  questionId: string;
  candidateId: string;
  agentClassRef: string;
  providerRef: string;
  modelRef: string;
}

/** Fully bounded Span Decisions request plus its question id mapping. */
export interface SpanEvaluationRequest {
  model: typeof SPAN_MODEL;
  state: Record<string, unknown>;
  questions: Record<string, SpanNoulQuestion>;
  candidates: SpanCandidateBinding[];
}

export interface SpanSubtaskEvaluationRequest {
  subtaskId: string;
  candidateSetFingerprint: string;
  request: SpanEvaluationRequest;
}

/** Normalized adapter outcome; never carries raw provider payloads. */
export type SpanEvaluationOutcome =
  | {
      ok: true;
      resolvedModel: string;
      /** Probabilities keyed by `questionId`. */
      probabilities: Record<string, number>;
      usage?: SpanUsage;
      durationMs: number;
    }
  | {
      ok: false;
      reason: SpanFallbackReason;
      durationMs: number;
    };

/**
 * Raised when the caller aborted Span evaluation. Cancellation propagates
 * instead of becoming a scored fallback, so a cancelled Turn never admits work
 * on the strength of a late observation.
 *
 * It lives in this pure module so the Application Shell can distinguish it
 * without importing the SDK-backed adapter.
 */
export class SpanEvaluationAbortedError extends Error {
  constructor() {
    super('Span evaluation aborted');
    this.name = 'AbortError';
  }
}

/**
 * Application-Shell seam consumed by `ConversationSession`. The Server
 * composition injects the SecretStore-backed implementation; recovery/system
 * bindings inject `null` and the plan path simply keeps the deterministic
 * resolver.
 */
export interface SpanRoutingEvaluator {
  evaluate(input: {
    /**
     * Exact pinned configuration revision of the proposal. The Server resolves
     * that revision's credential instead of whatever is currently active, so a
     * retried or replanned event cannot be re-scored with newer routing policy.
     */
    configurationRevision: string;
    /** Absolute deadline for the whole proposal, in milliseconds. */
    deadlineMs: number;
    signal?: AbortSignal;
    requests: readonly SpanSubtaskEvaluationRequest[];
  }): Promise<{
    subtasks: SpanSubtaskObservation[];
    usage?: SpanUsage;
  }>;
}
