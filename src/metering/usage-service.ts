/**
 * Runtime usage recorder.
 *
 * Adapters emit provider facts; this service is the only place that turns
 * those facts into normalized, durable observations. It is intentionally
 * side-effect free with respect to scheduling and execution.
 */

import type { MeteringSpanRecord, MeteringStore, ModelUsageFact, PersistedUsageObservation } from './ports.js';
import {
  normalizeUsageEvents,
  type NormalizationIssue,
  type RawUsageEvent,
} from './usage-normalizer.js';

export interface UsageRecorder {
  openSpan(span: MeteringSpanRecord): void;
  record(event: RawUsageEvent): number;
}

export function createUsageRecorder(deps: {
  readonly metering: MeteringStore;
  readonly now?: () => string;
}): UsageRecorder {
  return {
    openSpan(span) {
      deps.metering.openSpan(span);
    },
    record(event) {
      const persist = () => {
        const previousSnapshots = deps.metering.listCumulativeSnapshots([event.sourceId]);
        const knownSourceEventKeys = deps.metering
          .listObservations(event.queryId)
          .filter(observation => observation.sourceId === event.sourceId)
          .map(observation => `${observation.sourceId}#${observation.sourceEventKey}`);
        const normalized = normalizeUsageEvents({
          events: [event],
          previousSnapshots,
          knownSourceEventKeys,
        });
        const spans = deps.metering.listSpans(event.queryId);
        const span = spans.find(candidate => candidate.sourceId === event.sourceId
          && candidate.callId === event.callId)
          ?? (event.sourceId === 'planner' && spans.length === 1 ? spans[0] : null);
        const observations: PersistedUsageObservation[] = normalized.observations.map(observation => ({
          observationId: observation.observationId,
          spanId: span?.spanId ?? null,
          sourceId: observation.sourceId,
          sourceEventKey: observation.sourceEventKey,
          sourceScope: observation.sourceScope,
          callId: observation.callId,
          queryId: observation.queryId,
          executionSegmentId: observation.executionSegmentId,
          taskId: observation.taskId,
          stage: observation.stage,
          reason: observation.reason,
          resource: observation.resource,
          metric: observation.metric,
          unit: observation.unit,
          quantityNumerator: observation.quantity.numerator,
          quantityDenominator: observation.quantity.denominator,
          quality: observation.quality,
          countsTowardTotal: observation.countsTowardTotal,
          payer: observation.payer,
          agentClassRef: observation.agentClassRef,
          providerRef: observation.providerRef,
          modelId: observation.modelId,
          capturedAt: observation.capturedAt,
          providerBindingVersion: observation.providerBindingVersion,
          evidenceRef: observation.evidenceRef,
          normalizationRuleVersion: observation.normalizationRuleVersion,
          cumulativeValue: observation.cumulativeValue ?? null,
        }));
        const inserted = deps.metering.insertObservations(observations);
        if (event.counters.some(counter => counter.resource === 'model_tokens')
          || event.missing?.some(metric => metric.resource === 'model_tokens')) {
          const callObservations = deps.metering.listObservations(event.queryId).filter(observation => (
            observation.sourceId === event.sourceId && observation.callId === event.callId
            && observation.resource === 'model_tokens'
          ));
          const tokens = (metric: string): string | null => {
            const values = callObservations.filter(observation => observation.metric === metric
              && observation.quality === 'reported' && observation.unit === 'token');
            if (!values.length || values.some(value => value.quantityDenominator !== '1'
              || !/^\d+$/u.test(value.quantityNumerator))) return null;
            return values.reduce((sum, value) => sum + BigInt(value.quantityNumerator), 0n).toString();
          };
          const inputTokens = tokens('input');
          const outputTokens = tokens('output');
          const identity = JSON.stringify([event.queryId, event.sourceId, event.callId]);
          const fact: ModelUsageFact = {
            usageId: `usage:${identity}`, callIdempotencyKey: identity,
            queryId: event.queryId, taskId: event.taskId ?? null,
            providerRef: event.providerRef ?? null, modelId: event.modelId ?? null,
            agentClassRef: event.agentClassRef ?? null, payer: event.payer ?? 'unknown',
            inputTokens, outputTokens, cacheReadTokens: tokens('cache_read'),
            cacheWriteTokens: tokens('cache_write'), reasoningTokens: tokens('reasoning'),
            usageSource: inputTokens !== null && outputTokens !== null ? 'reported' : 'provider_unavailable',
            occurredAtUtc: callObservations[0]?.capturedAt ?? event.capturedAt,
            recordedAtUtc: deps.now?.() ?? new Date().toISOString(),
            sourceId: event.sourceId, providerResponseId: event.providerResponseId ?? null,
            normalizationVersion: 'usage-normalizer-v1',
          };
          deps.metering.recordModelUsageFact?.(fact);
        }
        const issues: (NormalizationIssue & { queryId: string })[] = normalized.issues.map(issue => ({
          ...issue,
          queryId: event.queryId,
        }));
        if (issues.length > 0) deps.metering.recordIssues(issues);
        return inserted;
      };
      return deps.metering.transaction ? deps.metering.transaction(persist) : persist();
    },
  };
}
