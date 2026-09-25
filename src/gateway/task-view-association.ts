import type { GatewayEventEnvelope } from './client-events.js';

export type TaskViewTurnAssociation =
  | {
      readonly status: 'matched';
      readonly startedAt: string | null;
      readonly completedAt: string | null;
      readonly progressSummary: string | null;
    }
  | { readonly status: 'mismatch' | 'not_found' };

export function resolveTaskViewTurnAssociation(input: {
  readonly accountId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly replayEvents: readonly GatewayEventEnvelope[];
  readonly queryTaskId?: string | null;
  readonly liveTaskId?: string | null;
  readonly presentationTaskId?: string | null;
}): TaskViewTurnAssociation {
  const traceEvents = input.replayEvents.filter(event => (
    event.accountId === input.accountId
    && event.conversationId === input.conversationId
    && event.kind === 'trace_delta'
    && (event.turnId === input.turnId || record(event.payload).turnId === input.turnId)
  ));
  const traceTaskIds = new Set(traceEvents
    .map(event => record(event.payload).taskId)
    .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0));
  const authoritativeTaskIds = new Set(traceTaskIds);
  if (input.queryTaskId) authoritativeTaskIds.add(input.queryTaskId);
  if (input.liveTaskId) authoritativeTaskIds.add(input.liveTaskId);
  if (input.presentationTaskId) authoritativeTaskIds.add(input.presentationTaskId);

  if (authoritativeTaskIds.size > 1) return { status: 'mismatch' };
  if (authoritativeTaskIds.size === 0) return { status: 'not_found' };
  if (!authoritativeTaskIds.has(input.taskId)) return { status: 'mismatch' };

  const latest = traceEvents.at(-1);
  const payload = record(latest?.payload);
  const traceItems = Array.isArray(payload.events) ? payload.events : [];
  const progressSummary = traceItems
    .map(record)
    .reverse()
    .map(item => item.summary)
    .find((summary): summary is string => typeof summary === 'string' && summary.length > 0)
    ?? null;
  const startedAt = traceEvents[0]?.occurredAt ?? null;
  const completedAt = typeof payload.completedAt === 'string'
    ? payload.completedAt
    : ['completed', 'failed', 'blocked', 'cancelled'].includes(String(payload.status))
      ? latest?.occurredAt ?? null
      : null;

  return { status: 'matched', startedAt, completedAt, progressSummary };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
