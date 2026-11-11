import { deriveAgentAvailability } from './agent-availability.js';
import type { ControlExecutorStatusProjection } from './executor-status-projection.js';

/**
 * Kernel-owned Executor availability policy.
 *
 * Extracted unchanged from the old Kernel so the Server-side Span advisor can
 * exclude exactly the same AgentClasses from scoring. This is a pure function
 * over Kernel status projections and the event timestamp: no clock, storage or
 * network access.
 */
export function unavailableAgentClasses(
  statuses: readonly ControlExecutorStatusProjection[],
  occurredAt: string,
): Set<string> {
  return new Set(statuses
    .filter(status => ['permanently_unavailable', 'temporarily_unavailable'].includes(
      deriveAgentAvailability(status, occurredAt),
    ))
    .map(status => status.agentClassName));
}
