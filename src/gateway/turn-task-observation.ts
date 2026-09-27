import type { GatewayEventEnvelope } from './client-events.js';

export interface TurnTaskObservationIdentity {
  readonly accountId: string;
  readonly conversationId: string;
  readonly turnId: string;
}

/** Trace evidence for presentation only, never Task lifecycle authority. */
export interface TurnTaskObservation extends TurnTaskObservationIdentity {
  /** Two distinct IDs permanently establish ambiguity; further IDs add no evidence. */
  readonly taskIds: readonly string[];
  readonly firstTraceAt: string;
  readonly latestTraceAt: string;
  readonly completedAt: string | null;
  readonly progressSummary: string | null;
}

export function traceObservationTurnIds(event: GatewayEventEnvelope): string[] {
  if (event.kind !== 'trace_delta') return [];
  // The resolver historically accepts envelope OR payload identity, including
  // disagreement. Preserve both observations rather than choosing an authority.
  return [...new Set([event.turnId, record(event.payload).turnId]
    .filter((id): id is string => typeof id === 'string'))];
}

export function matchesTurnTaskObservation(
  scope: TurnTaskObservationIdentity,
  observation: TurnTaskObservationIdentity,
): boolean {
  return observation.accountId === scope.accountId
    && observation.conversationId === scope.conversationId
    && observation.turnId === scope.turnId;
}

/** Fold committed traces in journal order, not wall-clock timestamp order. */
export function observeTurnTaskTrace(
  scope: TurnTaskObservationIdentity,
  previous: TurnTaskObservation | null,
  event: GatewayEventEnvelope,
): TurnTaskObservation | null {
  const current = previous && matchesTurnTaskObservation(scope, previous) ? previous : null;
  if (event.accountId !== scope.accountId || event.conversationId !== scope.conversationId
    || !traceObservationTurnIds(event).includes(scope.turnId)) return current;
  const payload = record(event.payload);
  const taskIds = [...(current?.taskIds ?? [])];
  if (typeof payload.taskId === 'string' && payload.taskId.length > 0
    && taskIds.length < 2 && !taskIds.includes(payload.taskId)) taskIds.push(payload.taskId);
  const traceItems = Array.isArray(payload.events) ? payload.events : [];
  const progressSummary = traceItems.map(record).reverse()
    .map(item => item.summary)
    .find((summary): summary is string => typeof summary === 'string' && summary.length > 0) ?? null;
  return {
    accountId: scope.accountId, conversationId: scope.conversationId, turnId: scope.turnId, taskIds,
    firstTraceAt: current?.firstTraceAt ?? event.occurredAt,
    latestTraceAt: event.occurredAt,
    completedAt: typeof payload.completedAt === 'string'
      ? payload.completedAt
      : ['completed', 'failed', 'blocked', 'cancelled'].includes(String(payload.status))
        ? event.occurredAt : null,
    progressSummary,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
