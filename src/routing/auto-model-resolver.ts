import type {
  AutoModelObjective,
  ModelCapability,
  ModelPolicy,
} from '../configuration/types.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { ModelRoutingNotes } from '../configuration/types.js';
import { isModelExecutionConstraint } from './model-execution-constraints.js';
import type { OpenRouterPublicFacts } from '../configuration/openrouter-model-catalog.js';

export const AUTO_MODEL_ROUTING_POLICY_VERSION = 'auto-model-routing-v2';
/**
 * Policy version recorded when a validated Span observation participated in
 * ranking. Span is a soft ordering signal only; the deterministic comparator
 * still decides every tie and remains the only path when no observation exists.
 */
export const SPAN_ROUTING_POLICY_VERSION = 'span-routing-v2';

export type ModelHealth = 'healthy' | 'degraded' | 'unavailable';

export interface AutoModelCandidate {
  providerRef: string;
  modelRef: string;
  modelId: string;
  description?: string;
  routingNotes?: ModelRoutingNotes;
  publicFacts?: OpenRouterPublicFacts;
  capabilities: readonly ModelCapability[];
  contextLimit?: number;
  costInputPerMillion?: number;
  costOutputPerMillion?: number;
  latencyTier?: 'low' | 'medium' | 'high';
  qualityTier?: 'low' | 'medium' | 'high';
  health: ModelHealth;
  available: boolean;
  providerEnabled?: boolean;
  harnessCompatible?: boolean;
  capacityAvailable?: boolean;
}

export interface AutoModelRequirements {
  /** Objective model execution requirements; broad quality labels are ignored. */
  requiredCapabilities?: readonly ModelCapability[];
  /** Legacy caller metadata; never used for eligibility or ranking. */
  preferredCapabilities: readonly ModelCapability[];
  contextTokens: number;
  requiresStructuredOutput?: boolean;
  maxCostPerTurn?: number;
  maxLatencyMs?: number;
  estimatedOutputTokens?: number;
  /** Legacy metadata; semantic interpretation belongs to the decision model. */
  taskText?: string;
}

export interface RejectedModelCandidate {
  modelRef: string;
  providerRef: string;
  reason: string;
}

export interface ModelScoreBreakdown {
  modelRef: string;
  objective: AutoModelObjective['priority'];
  preferredCapabilityMatchCount: number;
  preferredCapabilityMissCount: number;
  estimatedCost: number | null;
  estimatedLatencyMs: number;
  qualityScore: number;
  modelFitScore: number;
  totalScore: number;
  /**
   * Validated Mercury joint-choice probability for this candidate, when one applied.
   * Kept separate from `totalScore`: it is a different scale and must never be
   * folded into the deterministic cost/latency/quality arithmetic.
   */
  spanProbability?: number;
}

export interface AutoModelResolution {
  binding: AuthorizedExecutorBinding | null;
  fallbackCandidates: AuthorizedExecutorBinding[];
  rejectedCandidates: RejectedModelCandidate[];
  scoreBreakdown: ModelScoreBreakdown | null;
  policyVersion: string;
}

export interface RoutingResolutionAudit {
  agentClassRef: string;
  binding: AuthorizedExecutorBinding;
  rejectedCandidates: RejectedModelCandidate[];
  scoreBreakdown: ModelScoreBreakdown | null;
  policyVersion: string;
  /**
   * Span adoption facts. Present only when a Span observation existed for the
   * proposal; it records whether this Subtask's scores were accepted, why not,
   * and the adopted per-Model probabilities.
   */
  spanRouting?: {
    applied: boolean;
    reason: string | null;
    probabilities?: Record<string, number>;
  };
}

export interface AutoModelResolverInput {
  configurationRevision: string;
  agentClassRef: string;
  harnessRef: string;
  permissionProfileRef: string;
  policy: ModelPolicy;
  candidates: readonly AutoModelCandidate[];
  requirements: AutoModelRequirements;
  preferredModelRef?: string;
  /**
   * Optional validated Mercury choice probabilities keyed by Model ref. Only the
   * Kernel supplies this, and only after confirming the observation matches
   * the current event, revision, graph, Subtask and candidate set.
   */
  spanProbabilities?: Readonly<Record<string, number>>;
}

/** Narrows `candidates` to the Model refs the policy allows. */
export function autoModelPolicyConstraints(policy: ModelPolicy): {
  allowed: ReadonlySet<string>;
  order: ReadonlyMap<string, number>;
  objective: AutoModelObjective['priority'];
  objectiveConfig: AutoModelObjective | undefined;
} {
  const allowed = policy.mode === 'fixed'
    ? new Set([policy.modelRef])
    : new Set(policy.allowedModelRefs);
  const order = policy.mode === 'auto'
    ? new Map(policy.fallback?.order.map((ref, index) => [ref, index]) ?? [])
    : new Map<string, number>();
  const objective = policy.mode === 'auto'
    ? policy.objective?.priority ?? 'balanced'
    : 'balanced';
  const objectiveConfig = policy.mode === 'auto' ? policy.objective : undefined;
  return { allowed, order, objective, objectiveConfig };
}

/**
 * Single shared hard-eligibility filter used before Span evaluation and again
 * inside the Kernel. Callers must not maintain a second, looser candidate set.
 */
export function filterEligibleModelCandidates(input: {
  policy: ModelPolicy;
  candidates: readonly AutoModelCandidate[];
  requirements: AutoModelRequirements;
}): {
  eligible: AutoModelCandidate[];
  rejected: RejectedModelCandidate[];
} {
  const { allowed, objectiveConfig } = autoModelPolicyConstraints(input.policy);
  const eligible: AutoModelCandidate[] = [];
  const rejected: RejectedModelCandidate[] = [];
  for (const candidate of input.candidates) {
    if (!allowed.has(candidate.modelRef)) continue;
    const rejection = rejectCandidate(candidate, input.requirements, objectiveConfig);
    if (rejection) {
      rejected.push({
        modelRef: candidate.modelRef,
        providerRef: candidate.providerRef,
        reason: rejection,
      });
      continue;
    }
    eligible.push(candidate);
  }
  return { eligible, rejected };
}

export class AutoModelResolver {
  static resolve(input: AutoModelResolverInput): AutoModelResolution {
    const { order, objective } = autoModelPolicyConstraints(input.policy);
    const { eligible: eligibleCandidates, rejected: rejectedCandidates } =
      filterEligibleModelCandidates({
        policy: input.policy,
        candidates: input.candidates,
        requirements: input.requirements,
      });
    const spanApplied = Boolean(
      input.spanProbabilities && Object.keys(input.spanProbabilities).length > 0,
    );
    const eligible: Array<{
      candidate: AutoModelCandidate;
      score: ModelScoreBreakdown;
    }> = eligibleCandidates.map(candidate => ({
      candidate,
      score: scoreCandidate(
        candidate,
        input.requirements,
        objective,
        spanApplied ? input.spanProbabilities?.[candidate.modelRef] : undefined,
      ),
    }));

    if (eligible.length === 0) {
      const rejected = rejectedCandidates.length > 0
        ? ` (${rejectedCandidates
          .map(candidate => `${candidate.modelRef}: ${candidate.reason}`)
          .join('; ')})`
        : '';
      throw new Error(
        `no eligible model candidate${rejected}`,
      );
    }

    eligible.sort((left, right) => (
      spanProbabilityRank(input.spanProbabilities, right.candidate.modelRef)
        - spanProbabilityRank(input.spanProbabilities, left.candidate.modelRef)
      || ((objective === 'cost' || objective === 'balanced')
        ? Number(left.score.estimatedCost === null) - Number(right.score.estimatedCost === null)
        : 0)
      || left.score.totalScore - right.score.totalScore
      || Number(right.candidate.modelRef === input.preferredModelRef)
        - Number(left.candidate.modelRef === input.preferredModelRef)
      || (order.get(left.candidate.modelRef) ?? Number.MAX_SAFE_INTEGER)
        - (order.get(right.candidate.modelRef) ?? Number.MAX_SAFE_INTEGER)
      || left.candidate.modelRef.localeCompare(right.candidate.modelRef)
    ));
    const selected = eligible[0]!;
    const fallbackCandidates = eligible.map(({ candidate }) => ({
      agentClassRef: input.agentClassRef,
      harnessRef: input.harnessRef,
      providerRef: candidate.providerRef,
      modelRef: candidate.modelRef,
      permissionProfileRef: input.permissionProfileRef,
      configurationRevision: input.configurationRevision,
    }));
    return {
      binding: fallbackCandidates[0] ?? null,
      fallbackCandidates,
      rejectedCandidates: rejectedCandidates.sort(compareRejected),
      scoreBreakdown: selected.score,
      policyVersion: spanApplied
        ? SPAN_ROUTING_POLICY_VERSION
        : AUTO_MODEL_ROUTING_POLICY_VERSION,
    };
  }
}

function rejectCandidate(
  candidate: AutoModelCandidate,
  requirements: AutoModelRequirements,
  objective: AutoModelObjective | undefined,
): string | null {
  if (candidate.providerEnabled === false) return 'provider_disabled';
  if (candidate.harnessCompatible === false) return 'harness_incompatible';
  if (candidate.capacityAvailable === false) return 'capacity_unavailable';
  if (!candidate.available || candidate.health === 'unavailable') return 'unavailable';
  if (candidate.health === 'degraded') return 'health_degraded';
  for (const capability of requirements.requiredCapabilities ?? []) {
    if (isModelExecutionConstraint(capability) && !candidate.capabilities.includes(capability)) {
      return `missing_capability:${capability}`;
    }
  }
  if (requirements.requiresStructuredOutput && !candidate.capabilities.includes('structured-output')) {
    return 'missing_capability:structured-output';
  }
  if (candidate.contextLimit !== undefined && candidate.contextLimit < requirements.contextTokens) {
    return 'context_window_insufficient';
  }
  const score = scoreCandidate(candidate, requirements, objective?.priority ?? 'balanced');
  const maxCost = requirements.maxCostPerTurn ?? objective?.maxCostPerTurn;
  if (maxCost !== undefined) {
    if (score.estimatedCost === null) return 'cost_unknown';
    if (score.estimatedCost > maxCost) return 'cost_limit_exceeded';
  }
  const maxLatency = requirements.maxLatencyMs ?? objective?.maxLatencyMs;
  if (maxLatency !== undefined && score.estimatedLatencyMs > maxLatency) return 'latency_limit_exceeded';
  if (objective?.minimumQualityTier && qualityRank(candidate.qualityTier) < qualityRank(objective.minimumQualityTier)) {
    return 'quality_tier_below_minimum';
  }
  return null;
}

function scoreCandidate(
  candidate: AutoModelCandidate,
  requirements: AutoModelRequirements,
  objective: AutoModelObjective['priority'],
  spanProbability?: number,
): ModelScoreBreakdown {
  const estimatedOutputTokens = requirements.estimatedOutputTokens ?? 4_000;
  const estimatedCost = candidate.costInputPerMillion === undefined
    || candidate.costOutputPerMillion === undefined ? null : (
      candidate.costInputPerMillion * requirements.contextTokens
      + candidate.costOutputPerMillion * estimatedOutputTokens
    ) / 1_000_000;
  const estimatedLatencyMs = latencyMs(candidate.latencyTier);
  const qualityScore = qualityRank(candidate.qualityTier);
  // Retained audit fields remain readable for old decisions. New decisions do
  // not score semantic tags or task wording in the deterministic Kernel.
  const modelFitScore = 0;
  const preferredCapabilityMatchCount = 0;
  const preferredCapabilityMissCount = 0;
  const costScore = (estimatedCost ?? 0) * 1_000;
  const latencyScore = estimatedLatencyMs / 10;
  const qualityPenalty = (3 - qualityScore) * 100;
  const totalScore = objective === 'quality'
    ? qualityPenalty + costScore * 0.05 + latencyScore * 0.05
    : objective === 'cost'
      ? costScore + latencyScore * 0.05 + qualityPenalty * 0.1
      : objective === 'latency'
        ? latencyScore + costScore * 0.1 + qualityPenalty * 0.1
        : costScore + latencyScore + qualityPenalty;
  return {
    modelRef: candidate.modelRef,
    objective,
    preferredCapabilityMatchCount,
    preferredCapabilityMissCount,
    estimatedCost,
    estimatedLatencyMs,
    qualityScore,
    modelFitScore,
    totalScore,
    ...(spanProbability !== undefined ? { spanProbability } : {}),
  };
}

function spanProbabilityRank(
  probabilities: Readonly<Record<string, number>> | undefined,
  modelRef: string,
): number {
  const value = probabilities?.[modelRef];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function latencyMs(tier: AutoModelCandidate['latencyTier']): number {
  return tier === 'low' ? 800 : tier === 'high' ? 4_000 : 2_000;
}

function qualityRank(tier: AutoModelCandidate['qualityTier'] | undefined): number {
  return tier === 'high' ? 3 : tier === 'medium' ? 2 : 1;
}

function compareRejected(left: RejectedModelCandidate, right: RejectedModelCandidate): number {
  return left.modelRef.localeCompare(right.modelRef) || left.reason.localeCompare(right.reason);
}
