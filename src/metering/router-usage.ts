import type { RawUsageEvent } from './usage-normalizer.js';

/**
 * Decision-model usage of one Router call, as a metering fact.
 *
 * The Router chooses an Authorized Executor with the MetaWork decision model:
 * that call is platform overhead, not user work. It is recorded with
 * `payer: 'system'` so the fact exists for observability (timeline, missing-call
 * alerts, per-call coverage) while a user's `Included` quota, which only counts
 * `platform` work, is unaffected (ADR-0055 D4).
 */
export function routerDecisionUsageEvent(record: {
  readonly queryId: string | null;
  readonly routeDecisionId: string;
  readonly taskId: string;
  readonly subtaskId: string;
  readonly attemptOrdinal: number;
  readonly providerRef: string;
  readonly modelId: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly occurredAtUtc: string;
}): RawUsageEvent | null {
  if (!record.queryId) return null;
  const counters: RawUsageEvent['counters'] = record.usage
    ? [
      ...(record.usage.inputTokens !== undefined
        ? [{
          resource: 'model_tokens', metric: 'input', unit: 'token',
          kind: 'delta' as const, value: String(record.usage.inputTokens),
        }]
        : []),
      ...(record.usage.outputTokens !== undefined
        ? [{
          resource: 'model_tokens', metric: 'output', unit: 'token',
          kind: 'delta' as const, value: String(record.usage.outputTokens),
        }]
        : []),
    ]
    : [];
  return {
    sourceId: 'router',
    // One source event per persisted route decision: a replay of the same
    // decision is a duplicate event, never a second call.
    sourceEventKey: record.routeDecisionId,
    sourceScope: 'model_request',
    callId: `route:${record.taskId}:${record.subtaskId}:${record.attemptOrdinal}`,
    queryId: record.queryId,
    taskId: record.taskId,
    stage: 'planning',
    reason: 'primary',
    payer: 'system',
    agentClassRef: 'router',
    providerRef: record.providerRef,
    modelId: record.modelId,
    capturedAt: record.occurredAtUtc,
    providerResponseId: null,
    counters,
    // The call happened but its adapter reported no usage: that is explicitly
    // missing, never zero (ADR-0055 D4).
    ...(counters.length > 0 ? {} : {
      missing: [
        { resource: 'model_tokens' as const, metric: 'input', unit: 'token' as const },
        { resource: 'model_tokens' as const, metric: 'output', unit: 'token' as const },
      ],
    }),
  };
}
