import { afterEach, describe, expect, it } from 'vitest';
import { projectTokenUsageTimeline, resolveUsageRange } from '../../src/metering/token-usage-timeline.js';
import { TokenUsageService } from '../../src/metering/token-usage-service.js';
import { readAccountTokenQuota } from '../../src/metering/account-token-quota.js';
import { DEFAULT_PLAN_QUOTA_CATALOG } from '../../src/metering/plan-quota.js';
import { createTokenUsageManagementQuery } from '../../src/management/token-usage-management.js';
import type { ModelUsageFact } from '../../src/metering/ports.js';
import { beginQuery, createMeteringHarness, type MeteringHarness } from '../support/metering-harness.js';
import { PiCliDriver } from '../../src/executor/pi-cli-driver.js';
import { createUsageRecorder } from '../../src/metering/usage-service.js';

const now = new Date('2026-11-09T16:01:00.000Z');
const fact = (id: string, overrides: Partial<ModelUsageFact> = {}): ModelUsageFact => ({
  usageId: id, queryId: 'q', callIdempotencyKey: id, taskId: null, modelId: 'model', providerRef: 'provider',
  payer: 'platform', agentClassRef: 'manager', inputTokens: '10', outputTokens: '5',
  cacheReadTokens: '8', cacheWriteTokens: '2', reasoningTokens: '3', usageSource: 'reported', recordedAtUtc: '2026-11-10T00:00:00.000Z', sourceId: 'fixture', providerResponseId: null, normalizationVersion: 'fixture-v1',
  occurredAtUtc: '2026-11-09T16:00:00.000Z', ...overrides,
});
let harness: MeteringHarness | undefined;
afterEach(() => harness?.close());

describe('Beijing usage timeline', () => {
  it.each([
    ['today', '2026-11-09T16:00:00.000Z', '2026-11-10T16:00:00.000Z'],
    ['week', '2026-11-08T16:00:00.000Z', '2026-11-10T16:00:00.000Z'],
    ['7days', '2026-11-03T16:00:00.000Z', '2026-11-10T16:00:00.000Z'],
    ['30days', '2026-10-11T16:00:00.000Z', '2026-11-10T16:00:00.000Z'],
    ['month', '2026-10-31T16:00:00.000Z', '2026-11-10T16:00:00.000Z'],
    ['lastMonth', '2026-09-30T16:00:00.000Z', '2026-10-31T16:00:00.000Z'],
  ])('resolves %s from the Beijing calendar', (period, from, to) => {
    expect(resolveUsageRange({ period }, now)).toMatchObject({ from, to });
  });
  it('handles year boundaries, leap dates, Mondays and activation-relative trial windows', () => {
    expect(resolveUsageRange({ period: 'lastMonth' }, new Date('2026-12-31T16:00:00.000Z')))
      .toMatchObject({ start: '2026-12-01', end: '2026-12-31' });
    expect(resolveUsageRange({ period: 'week' }, new Date('2026-11-08T16:00:00.000Z')))
      .toMatchObject({ start: '2026-11-09', end: '2026-11-09' });
    expect(resolveUsageRange({ period: 'custom', start: '2024-02-29', end: '2024-03-01' }, now))
      .toMatchObject({ from: '2024-02-28T16:00:00.000Z', to: '2024-03-01T16:00:00.000Z' });
    const trial = { start: '2026-11-01T03:12:00.000Z', end: '2026-11-08T03:12:00.000Z' };
    const range = resolveUsageRange({ period: 'subscription' }, now, trial);
    expect(range).toMatchObject({ from: trial.start, to: trial.end });
    expect(projectTokenUsageTimeline([], range, 'model').days).toHaveLength(8);
  });
  it.each([
    { period: 'invalid' }, { groupBy: 'account' }, { period: 'today', start: '2026-01-01' },
    { period: 'custom', start: '2026-02-29', end: '2026-03-01' },
    { period: 'custom', start: '2026-01-02', end: '2026-01-01' },
    { period: 'custom', start: '2024-01-01', end: '2025-01-01' },
    { period: 'custom' }, { period: 'subscription' },
  ])('rejects malformed or unbounded ranges: %j', input => {
    expect(() => resolveUsageRange(input, now)).toThrow();
  });
  it('preserves exact counts, excludes system, keeps unknown explicit and fills zero days', () => {
    const range = resolveUsageRange({ period: '7days' }, now);
    const result = projectTokenUsageTimeline([
      fact('a', { inputTokens: '9007199254740993' }),
      fact('b', { payer: 'user_direct', occurredAtUtc: '2026-11-09T15:59:59.999Z' }),
      fact('c', { payer: 'system', inputTokens: '99999999999999999999' }),
      fact('d', { payer: 'unknown', inputTokens: null, outputTokens: '2', usageSource: 'provider_unavailable' }),
      fact('end', { occurredAtUtc: range.to }), fact('before', { occurredAtUtc: '2026-11-03T15:59:59.999Z' }),
    ], range, 'model');
    expect(result.totals).toEqual({ totalTokens: '9007199254741015', includedTokens: '9007199254740998', onDemandTokens: '15', unattributedTokens: '2', calls: 3, missingCalls: 1, unattributedCalls: 1 });
    expect(result.days).toHaveLength(7);
    expect(result.days[0]?.totalTokens).toBe('0');
    expect(result.days[5]).toMatchObject({ date: '2026-11-09', totalTokens: '15' });
    expect(result.days[6]?.totalTokens).toBe('9007199254741000');
    expect(result.series[0]?.tokens).toBe(result.totals.totalTokens);
  });
  it('groups by model or provider without collisions on null and special names', () => {
    const range = resolveUsageRange({ period: 'today' }, now);
    const facts = [fact('a', { modelId: null }), fact('b', { modelId: '__proto__' }), fact('c', { modelId: '未记录模型', providerRef: 'other' })];
    const model = projectTokenUsageTimeline(facts, range, 'model');
    expect(model.series).toHaveLength(3);
    expect(Object.keys(model.days[0]!.values)).toHaveLength(3);
    const provider = projectTokenUsageTimeline(facts, range, 'provider');
    expect(provider.series.map(item => item.tokens).sort()).toEqual(['15', '30']);
    expect(provider.totals).toEqual(model.totals);
  });
  it('reads only server account facts and counts every official role in quota', () => {
    harness = createMeteringHarness();
    beginQuery(harness, { queryId: 'q', accountId: 'a' });
    beginQuery(harness, { queryId: 'other', accountId: 'b' });
    for (const row of [fact('manager'), fact('executor', { agentClassRef: 'pi' }), fact('memory', { agentClassRef: 'memory' }),
      fact('own', { payer: 'user_direct' }), fact('unknown', { payer: 'unknown' }), fact('internal', { payer: 'system' }),
      fact('other', { queryId: 'other' }), fact('orphan', { queryId: 'orphan' })]) harness.metering.recordModelUsageFact(row);
    const usage = new TokenUsageService(harness.metering);
    const query = createTokenUsageManagementQuery({ accountId: 'a', usage, now: () => now,
      quotaContext: date => readAccountTokenQuota({ accountId: 'a', usage, catalog: DEFAULT_PLAN_QUOTA_CATALOG, planId: 'free-baseline', now: date }),
    });
    const result = query.read({ period: 'subscription' });
    expect(result.totals).toMatchObject({ totalTokens: '75', includedTokens: '45', onDemandTokens: '15', unattributedTokens: '15', calls: 5 });
    expect(result.quota).toMatchObject({ usedTokens: '45', remainingTokens: '999955' });
    expect(result.range.from).toBe(result.quotaWindow.start);
    expect(result.range.to).toBe(result.quotaWindow.end);
    expect(JSON.stringify(result)).not.toMatch(/price|cost|credential|queryId/u);
  });

  it('counts cached Pi tokens once from the adapter through SQLite, timeline and quota', () => {
    harness = createMeteringHarness();
    beginQuery(harness, { queryId: 'q', accountId: 'a' });
    const parsed = new PiCliDriver().parseUsageLine({ stream: 'stdout', line: JSON.stringify({
      type: 'message_end', message: { id: 'cached', role: 'assistant',
        usage: { input: 12, output: 5, cacheRead: 3, cacheWrite: 1 } },
    }) })!;
    const recorder = createUsageRecorder({
      metering: harness.metering,
      now: () => '2026-11-10T00:00:00.000Z',
    });
    const event = { ...parsed, queryId: 'q', sourceId: 'executor', sourceScope: 'model_request' as const,
      agentClassRef: 'pi', payer: 'platform' as const, capturedAt: now.toISOString() };
    recorder.record(event);
    recorder.record(event);
    const usage = new TokenUsageService(harness.metering);
    // The occurrence time is the adapter-observed completion time; the record
    // time is when this host wrote the fact. Source identity is carried, not
    // replaced by a fixture default, so the timeline can attribute the call.
    expect(usage.list({ accountId: 'a' })).toEqual([expect.objectContaining({
      inputTokens: '16', outputTokens: '5', cacheReadTokens: '3', cacheWriteTokens: '1',
      usageSource: 'reported', occurredAtUtc: now.toISOString(),
      recordedAtUtc: '2026-11-10T00:00:00.000Z', sourceId: 'executor',
      providerResponseId: 'cached', normalizationVersion: 'usage-normalizer-v1',
    })]);
    expect(usage.timeline({ accountId: 'a' }, resolveUsageRange({ period: 'today' }, now), 'model').totals)
      .toMatchObject({ totalTokens: '21', includedTokens: '21', calls: 1, missingCalls: 0 });
    expect(readAccountTokenQuota({ accountId: 'a', usage, catalog: DEFAULT_PLAN_QUOTA_CATALOG, planId: 'free-baseline', now }).quota.usedTokens).toBe('21');
  });

  it('keeps two model calls of one attempt apart and dates each by occurrence, not record time', () => {
    harness = createMeteringHarness();
    beginQuery(harness, { queryId: 'q', accountId: 'a' });
    const recorder = createUsageRecorder({
      metering: harness.metering,
      now: () => '2026-11-10T02:00:00.000Z',
    });
    const call = (callId: string, capturedAt: string, input: string) => ({
      queryId: 'q', sourceId: 'harness:pi-cli:attempt_1', sourceScope: 'harness_turn' as const,
      callId: `attempt_1:${callId}`, sourceEventKey: `${callId}:end`,
      agentClassRef: 'pi', payer: 'platform' as const, capturedAt,
      counters: [{ resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta' as const, value: input }],
    });
    // First call completes late on the previous Beijing day; the second call
    // belongs to the current day. Both share one Attempt.
    recorder.record(call('call_1', '2026-11-09T15:30:00.000Z', '4'));
    recorder.record(call('call_2', '2026-11-09T17:30:00.000Z', '6'));
    const usage = new TokenUsageService(harness.metering);
    expect(usage.list({ accountId: 'a' })).toHaveLength(2);
    const timeline = usage.timeline({ accountId: 'a' }, resolveUsageRange({ period: 'today' }, now), 'model');
    expect(timeline.totals).toMatchObject({ totalTokens: '6', calls: 1 });
    const yesterday = usage.timeline(
      { accountId: 'a' },
      resolveUsageRange({ period: 'custom', start: '2026-11-09', end: '2026-11-09' }, now),
      'model',
    );
    expect(yesterday.totals).toMatchObject({ totalTokens: '4', calls: 1 });
    expect(usage.list({ accountId: 'a' }).every(fact => fact.recordedAtUtc === '2026-11-10T02:00:00.000Z')).toBe(true);
  });
});
