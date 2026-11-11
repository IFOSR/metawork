import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenUsageService } from '../../src/metering/token-usage-service.js';
import type { ModelUsageFact } from '../../src/metering/ports.js';
import { createUsageRecorder } from '../../src/metering/usage-service.js';
import type { RawUsageEvent } from '../../src/metering/usage-normalizer.js';
import { beginQuery, createMeteringHarness, type MeteringHarness } from '../support/metering-harness.js';
import { resolveUsageRange } from '../../src/metering/token-usage-timeline.js';

let harness: MeteringHarness;
afterEach(() => harness?.close());

function setup() {
  harness = createMeteringHarness();
  beginQuery(harness, { queryId: 'query-a', accountId: 'account-a' });
  beginQuery(harness, { queryId: 'query-b', accountId: 'account-b' });
  const fact = (queryId: string, overrides: Partial<ModelUsageFact> = {}): ModelUsageFact => ({
    usageId: queryId, callIdempotencyKey: queryId, queryId, taskId: 'task-shared',
    providerRef: 'provider', modelId: 'model', inputTokens: '9007199254740993',
    outputTokens: '2', cacheReadTokens: '1', cacheWriteTokens: null, reasoningTokens: null,
    usageSource: 'reported', recordedAtUtc: '2026-11-10T00:00:00.000Z', sourceId: 'fixture', providerResponseId: null, normalizationVersion: 'fixture-v1', occurredAtUtc: '2026-11-08T00:00:00.000Z', ...overrides,
  });
  harness.metering.recordModelUsageFact(fact('query-a'));
  harness.metering.recordModelUsageFact(fact('query-b'));
  harness.metering.recordModelUsageFact(fact('orphan'));
  return new TokenUsageService(harness.metering);
}

describe('account-scoped token usage', () => {
  it('aggregates a large SQLite period exactly without loading all facts into an array', () => {
    harness = createMeteringHarness();
    beginQuery(harness, { queryId: 'q', accountId: 'a' });
    harness.db.exec(`
      WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 100000)
      INSERT INTO model_usage_facts (usage_id, call_idempotency_key, query_id, payer,
        input_tokens, output_tokens, usage_source, occurred_at_utc, recorded_at_utc, source_id, normalization_version)
      SELECT 'usage-' || n, 'call-' || n, 'q', 'platform', '9007199254740993', '7',
        'reported', '2026-11-08T00:00:00.000Z', '2026-11-10T00:00:00.000Z', 'fixture', 'fixture-v1' FROM sequence;
    `);
    vi.spyOn(harness.metering, 'listModelUsageFacts').mockImplementation(() => {
      throw new Error('unbounded array materialization');
    });
    const service = new TokenUsageService(harness.metering);
    expect(service.aggregate({ accountId: 'a', payer: 'platform' })).toMatchObject({
      inputTokens: '900719925474099300000', outputTokens: '700000', calls: 100000, missingCalls: 0,
    });
    const range = resolveUsageRange({ period: 'custom', start: '2026-11-08', end: '2026-11-08' }, new Date());
    const timeline = service.timeline({ accountId: 'a' }, range, 'model');
    expect(timeline.totals).toMatchObject({ totalTokens: '900719925474100000000', calls: 100000 });
    expect(timeline.days).toHaveLength(1);
    expect(timeline.series).toHaveLength(1);
    expect(service.aggregate({ accountId: 'other' }).calls).toBe(0);
  }, 15000);

  it('records one exact call across cumulative updates and event replay', () => {
    harness = createMeteringHarness();
    beginQuery(harness, { queryId: 'q', accountId: 'a' });
    const recorder = createUsageRecorder({ metering: harness.metering });
    const event = (key: string, count: string): RawUsageEvent => ({
      queryId: 'q', sourceId: 'executor', callId: 'call', sourceEventKey: key,
      sourceScope: 'model_request', capturedAt: '2026-11-08T00:00:00.000Z',
      counters: [
        { resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'cumulative', value: '100' },
        { resource: 'model_tokens', metric: 'output', unit: 'token', kind: 'cumulative', value: count },
      ],
    });
    recorder.record(event('e1', '20'));
    recorder.record(event('e2', '35'));
    recorder.record(event('e2', '35'));
    expect(new TokenUsageService(harness.metering).aggregate({ accountId: 'a' }))
      .toMatchObject({ calls: 1, inputTokens: '100', outputTokens: '35', missingCalls: 0 });
    recorder.record({ ...event('e3', '10'), callId: 'retry' });
    expect(new TokenUsageService(harness.metering).aggregate({ accountId: 'a' }))
      .toMatchObject({ calls: 2, inputTokens: '200', outputTokens: '45' });
  });

  it('does not turn malformed, fractional or non-model counters into valid token usage', () => {
    harness = createMeteringHarness();
    beginQuery(harness, { queryId: 'q', accountId: 'a' });
    const recorder = createUsageRecorder({ metering: harness.metering });
    for (const [index, value] of ['1.5', '-3', 'NaN'].entries()) {
      recorder.record({ queryId: 'q', sourceId: 'executor', callId: `call-${index}`, sourceEventKey: `e-${index}`,
        sourceScope: 'model_request', capturedAt: '2026-11-08T00:00:00.000Z',
        counters: [{ resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta', value }] });
    }
    recorder.record({ queryId: 'q', sourceId: 'executor', callId: 'compute', sourceEventKey: 'compute',
      sourceScope: 'model_request', capturedAt: '2026-11-08T00:00:00.000Z',
      counters: [{ resource: 'compute', metric: 'cpu_second', unit: 'second', kind: 'delta', value: '3' }] });
    expect(new TokenUsageService(harness.metering).aggregate({ accountId: 'a' }))
      .toMatchObject({ calls: 3, inputTokens: '0', missingCalls: 3 });
  });

  it('rolls back normalized observations if the model-call projection cannot commit', () => {
    harness = createMeteringHarness();
    beginQuery(harness, { queryId: 'q', accountId: 'a' });
    harness.db.exec("CREATE TRIGGER reject_model_usage BEFORE INSERT ON model_usage_facts BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const recorder = createUsageRecorder({ metering: harness.metering });
    expect(() => recorder.record({ queryId: 'q', sourceId: 'executor', callId: 'call', sourceEventKey: 'e',
      sourceScope: 'model_request', capturedAt: '2026-11-08T00:00:00.000Z',
      counters: [{ resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta', value: '3' }] }))
      .toThrow('test failure');
    expect(harness.metering.listObservations('q')).toEqual([]);
  });
  it('excludes another account and orphan calls, including explicit query/task filters', () => {
    const service = setup();
    expect(service.list({ accountId: 'account-a' }).map(fact => fact.queryId)).toEqual(['query-a']);
    expect(service.list({ accountId: 'account-a', queryId: 'query-b' })).toEqual([]);
    expect(service.list({ accountId: 'account-a', taskId: 'task-shared' })).toHaveLength(1);
    expect(service.list({ accountId: 'account-b', queryId: 'orphan' })).toEqual([]);
    expect(() => harness.metering.listModelUsageFacts({ accountId: '' })).toThrow('usage_account_required');
  });

  it('keeps platform quota facts separate from user-owned Provider usage', () => {
    harness = createMeteringHarness();
    beginQuery(harness, { queryId: 'q-platform', accountId: 'a' });
    beginQuery(harness, { queryId: 'q-user', accountId: 'a' });
    const fact = (queryId: string, payer: ModelUsageFact['payer']): ModelUsageFact => ({
      usageId: queryId, callIdempotencyKey: queryId, queryId, taskId: null,
      providerRef: 'provider', modelId: 'model', agentClassRef: 'manager', payer,
      inputTokens: '10', outputTokens: '5', cacheReadTokens: null, cacheWriteTokens: null,
      reasoningTokens: null, usageSource: 'reported', recordedAtUtc: '2026-11-10T00:00:00.000Z', sourceId: 'fixture', providerResponseId: null, normalizationVersion: 'fixture-v1', occurredAtUtc: '2026-11-08T00:00:00.000Z',
    });
    harness.metering.recordModelUsageFact(fact('q-platform', 'platform'));
    harness.metering.recordModelUsageFact(fact('q-user', 'user_direct'));
    const service = new TokenUsageService(harness.metering);
    expect(service.aggregate({ accountId: 'a', agentClassRef: 'manager', payer: 'platform' }))
      .toMatchObject({ inputTokens: '10', outputTokens: '5', calls: 1 });
    expect(service.aggregate({ accountId: 'a', agentClassRef: 'manager', payer: 'user_direct' }))
      .toMatchObject({ inputTokens: '10', outputTokens: '5', calls: 1 });
  });

  it.each(['payer', 'queryId', 'taskId', 'providerRef', 'modelId', 'agentClassRef',
    'sourceId', 'providerResponseId', 'normalizationVersion', 'occurredAtUtc'] as const)(
    'does not let a replay rewrite the %s attribution of a call', field => {
    harness = createMeteringHarness();
    beginQuery(harness, { queryId: 'q', accountId: 'a' });
    const fact: ModelUsageFact = {
      usageId: 'u', callIdempotencyKey: 'call', queryId: 'q', taskId: null,
      providerRef: 'p', modelId: 'm', agentClassRef: 'manager', payer: 'platform',
      inputTokens: '1', outputTokens: '1', cacheReadTokens: null, cacheWriteTokens: null,
      reasoningTokens: null, usageSource: 'reported', recordedAtUtc: '2026-11-10T00:00:00.000Z', sourceId: 'fixture', providerResponseId: null, normalizationVersion: 'fixture-v1', occurredAtUtc: '2026-11-08T00:00:00.000Z',
    };
    harness.metering.recordModelUsageFact(fact);
    const changed = { ...fact, [field]: field === 'payer' ? 'user_direct'
      : field === 'occurredAtUtc' ? '2026-11-08T00:00:00.001Z'
        : field === 'providerResponseId' ? 'another-response'
          : 'another-identity' };
    expect(() => harness.metering.recordModelUsageFact(changed))
      .toThrow('model_usage_identity_conflict');
    expect(harness.metering.listModelUsageFacts({ accountId: 'a' })).toEqual([fact]);
  });

  it('preserves exact token totals and half-open UTC ranges', () => {
    const service = setup();
    expect(service.aggregate({ accountId: 'account-a', from: '2026-11-08T00:00:00.000Z' }))
      .toMatchObject({ inputTokens: '9007199254740993', outputTokens: '2', calls: 1, missingCalls: 0 });
    expect(service.aggregate({ accountId: 'account-a', to: '2026-11-08T00:00:00.000Z' }).calls).toBe(0);
    for (const from of ['yesterday', '2026-02-30T00:00:00.000Z', '2026-11-08T00:00:00+08:00']) {
      expect(() => service.aggregate({ accountId: 'account-a', from })).toThrow('usage_invalid_time_range');
    }
    expect(() => service.aggregate({ accountId: 'account-a',
      from: '2026-11-09T00:00:00.000Z', to: '2026-11-08T00:00:00.000Z' }))
      .toThrow('usage_invalid_time_range');
  });
});
