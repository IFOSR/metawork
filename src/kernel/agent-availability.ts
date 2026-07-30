import type { KernelExecutorStatusProjection, RecentExecutionAttempt } from './executor-status-projection.js';

export type DerivedAgentAvailability =
  | 'available'
  | 'permanently_unavailable'
  | 'temporarily_unavailable'
  | 'probe_eligible';

export interface AgentAvailabilityPolicy {
  failureWindowMs: number;
  consecutiveFailureThreshold: number;
  cooldownMs: number;
}

export const DEFAULT_AGENT_AVAILABILITY_POLICY: AgentAvailabilityPolicy = {
  failureWindowMs: 10 * 60_000,
  consecutiveFailureThreshold: 3,
  cooldownMs: 5 * 60_000,
};

const TRANSIENT_CLASS_FAILURES = new Set(['network', 'timeout', 'infrastructure']);

/** Pure interpretation of persisted recent-attempt facts; it stores no breaker state. */
export function deriveAgentAvailability(
  projection: KernelExecutorStatusProjection | null,
  occurredAt: string,
  policy: AgentAvailabilityPolicy = DEFAULT_AGENT_AVAILABILITY_POLICY,
): DerivedAgentAvailability {
  if (!projection) return 'available';
  if (projection.classHealth === 'disabled' || projection.classHealth === 'error') {
    return 'permanently_unavailable';
  }
  const now = Date.parse(occurredAt);
  if (!Number.isFinite(now)) return 'available';
  const consecutive: RecentExecutionAttempt[] = [];
  for (const attempt of projection.recentAttempts) {
    if (!isTransientClassFailure(attempt)) break;
    const completedAt = Date.parse(attempt.completedAt);
    if (!Number.isFinite(completedAt) || completedAt > now || now - completedAt > policy.failureWindowMs) break;
    consecutive.push(attempt);
  }
  if (consecutive.length < policy.consecutiveFailureThreshold) return 'available';
  const latestFailureAt = Date.parse(consecutive[0].completedAt);
  return now - latestFailureAt < policy.cooldownMs
    ? 'temporarily_unavailable'
    : 'probe_eligible';
}

function isTransientClassFailure(attempt: RecentExecutionAttempt): boolean {
  return attempt.outcome === 'failed'
    && attempt.failure?.scope === 'agent_class'
    && TRANSIENT_CLASS_FAILURES.has(attempt.failure.kind);
}
