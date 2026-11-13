import { describe, expect, it } from 'vitest';
import { routerDecisionUsageEvent } from '../../src/metering/router-usage.js';
import { createUsageRecorder } from '../../src/metering/usage-service.js';
import { TokenUsageService } from '../../src/metering/token-usage-service.js';
import { readAccountTokenQuota } from '../../src/metering/account-token-quota.js';
import { DEFAULT_PLAN_QUOTA_CATALOG } from '../../src/metering/plan-quota.js';
import { beginQuery, createMeteringHarness, type MeteringHarness } from '../support/metering-harness.js';

const record = {
  queryId: 'query-1',
  routeDecisionId: 'route_1',
  taskId: 'task-1',
  subtaskId: 'subtask-1',
  attemptOrdinal: 1,
  providerRef: 'metawork-router',
  modelId: 'span-routing-v1',
  usage: { inputTokens: 12, outputTokens: 3 },
  occurredAtUtc: '2026-11-10T00:00:00.000Z',
};

describe('Router decision-model usage facts', () => {
  it('records internal routing calls as system work, never as user Included usage', () => {
    const event = routerDecisionUsageEvent(record)!;
    expect(event).toMatchObject({
      sourceId: 'router',
      sourceEventKey: 'route_1',
      sourceScope: 'model_request',
      callId: 'route:task-1:subtask-1:1',
      queryId: 'query-1',
      taskId: 'task-1',
      stage: 'planning',
      reason: 'primary',
      payer: 'system',
      agentClassRef: 'router',
      providerRef: 'metawork-router',
      modelId: 'span-routing-v1',
      capturedAt: '2026-11-10T00:00:00.000Z',
    });
    expect(event.counters).toEqual([
      { resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta', value: '12' },
      { resource: 'model_tokens', metric: 'output', unit: 'token', kind: 'delta', value: '3' },
    ]);
    expect(event.missing).toBeUndefined();
  });

  it('marks a called model without usage as explicitly missing instead of zero', () => {
    const event = routerDecisionUsageEvent({ ...record, usage: undefined })!;
    expect(event.counters).toEqual([]);
    expect(event.missing).toEqual([
      { resource: 'model_tokens', metric: 'input', unit: 'token' },
      { resource: 'model_tokens', metric: 'output', unit: 'token' },
    ]);
  });

  it('produces no fact without an account-bound Query', () => {
    expect(routerDecisionUsageEvent({ ...record, queryId: null })).toBeNull();
  });

  it('does not consume the user Included quota while remaining visible in the timeline', () => {
    const harness: MeteringHarness = createMeteringHarness();
    try {
      beginQuery(harness, { queryId: 'query-1', accountId: 'a' });
      const recorder = createUsageRecorder({ metering: harness.metering });
      const event = routerDecisionUsageEvent(record)!;
      recorder.record(event);
      recorder.record(event);
      const usage = new TokenUsageService(harness.metering);
      const facts = usage.list({ accountId: 'a' });
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ payer: 'system', agentClassRef: 'router', sourceId: 'router', inputTokens: '12', outputTokens: '3' });
      const timeline = usage.timeline(
        { accountId: 'a' },
        { from: '2026-11-09T16:00:00.000Z', to: '2026-11-10T16:00:00.000Z', start: '2026-11-10', end: '2026-11-10' },
        'model',
      );
      expect(timeline.totals).toMatchObject({ totalTokens: '0', includedTokens: '0', calls: 0 });
      expect(readAccountTokenQuota({
        accountId: 'a', usage, catalog: DEFAULT_PLAN_QUOTA_CATALOG, planId: 'free-baseline',
        now: new Date('2026-11-10T00:00:00.000Z'),
      }).quota.usedTokens).toBe('0');
    } finally {
      harness.close();
    }
  });
});
