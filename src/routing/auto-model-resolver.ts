import type {
  AutoModelObjective,
  ModelCapability,
  ModelPolicy,
} from '../configuration/types.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';

export const AUTO_MODEL_ROUTING_POLICY_VERSION = 'auto-model-routing-v1';

export type ModelHealth = 'healthy' | 'degraded' | 'unavailable';

export interface AutoModelCandidate {
  providerRef: string;
  modelRef: string;
  modelId: string;
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
  /** Model capabilities that are mandatory for this exact binding. */
  requiredCapabilities?: readonly ModelCapability[];
  /** Model profile strengths used to rank candidates, not an eligibility gate. */
  preferredCapabilities: readonly ModelCapability[];
  contextTokens: number;
  requiresStructuredOutput?: boolean;
  maxCostPerTurn?: number;
  maxLatencyMs?: number;
  estimatedOutputTokens?: number;
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
  estimatedCost: number;
  estimatedLatencyMs: number;
  qualityScore: number;
  totalScore: number;
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
}

export class AutoModelResolver {
  static resolve(input: AutoModelResolverInput): AutoModelResolution {
    const rejectedCandidates: RejectedModelCandidate[] = [];
    const allowed = input.policy.mode === 'fixed'
      ? new Set([input.policy.modelRef])
      : new Set(input.policy.allowedModelRefs);
    const order = input.policy.mode === 'auto'
      ? new Map(input.policy.fallback?.order.map((ref, index) => [ref, index]) ?? [])
      : new Map<string, number>();
    const objective = input.policy.mode === 'auto'
      ? input.policy.objective?.priority ?? 'balanced'
      : 'balanced';
    const objectiveConfig = input.policy.mode === 'auto' ? input.policy.objective : undefined;
    const eligible: Array<{
      candidate: AutoModelCandidate;
      score: ModelScoreBreakdown;
    }> = [];

    for (const candidate of input.candidates) {
      if (!allowed.has(candidate.modelRef)) continue;
      const rejection = rejectCandidate(candidate, input.requirements, objectiveConfig);
      if (rejection) {
        rejectedCandidates.push({
          modelRef: candidate.modelRef,
          providerRef: candidate.providerRef,
          reason: rejection,
        });
        continue;
      }
      eligible.push({
        candidate,
        score: scoreCandidate(candidate, input.requirements, objective),
      });
    }

    if (eligible.length === 0) {
      throw new Error('no eligible model candidate');
    }

    eligible.sort((left, right) => (
      left.score.preferredCapabilityMissCount - right.score.preferredCapabilityMissCount
      || right.score.preferredCapabilityMatchCount - left.score.preferredCapabilityMatchCount
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
      policyVersion: AUTO_MODEL_ROUTING_POLICY_VERSION,
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
    if (!candidate.capabilities.includes(capability)) {
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
  if (maxCost !== undefined && score.estimatedCost > maxCost) return 'cost_limit_exceeded';
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
): ModelScoreBreakdown {
  const estimatedOutputTokens = requirements.estimatedOutputTokens ?? 4_000;
  const estimatedCost = (
    ((candidate.costInputPerMillion ?? 0) * requirements.contextTokens)
    + ((candidate.costOutputPerMillion ?? 0) * estimatedOutputTokens)
  ) / 1_000_000;
  const estimatedLatencyMs = latencyMs(candidate.latencyTier);
  const qualityScore = qualityRank(candidate.qualityTier);
  const preferredCapabilityMatchCount = requirements.preferredCapabilities
    .filter(capability => candidate.capabilities.includes(capability))
    .length;
  const preferredCapabilityMissCount = requirements.preferredCapabilities.length
    - preferredCapabilityMatchCount;
  const costScore = estimatedCost * 1_000;
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
    totalScore,
  };
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
