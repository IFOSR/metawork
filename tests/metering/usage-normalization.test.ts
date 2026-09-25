import { describe, expect, it } from 'vitest';
import { rational } from '../../src/billing/money.js';
import { rationalFromExactQuantity } from '../../src/metering/contracts.js';
import {
  NORMALIZATION_RULE_VERSION,
  normalizeUsageEvents,
  type RawUsageEvent,
} from '../../src/metering/usage-normalizer.js';

function event(overrides: Partial<RawUsageEvent> = {}): RawUsageEvent {
  return {
    sourceId: 'planner',
    sourceEventKey: 'evt-1',
    sourceScope: 'model_request',
    callId: 'call-1',
    queryId: 'query-1',
    capturedAt: '2026-09-21T10:00:00.000Z',
    counters: [{
      resource: 'model_tokens',
      metric: 'input',
      unit: 'token',
      kind: 'delta',
      value: '100',
    }],
    ...overrides,
  };
}

function totals(result: ReturnType<typeof normalizeUsageEvents>): bigint[] {
  return result.observations
    .filter(observation => observation.countsTowardTotal)
    .map(observation => rationalFromExactQuantity(observation.quantity).numerator);
}

describe('normalizeUsageEvents', () => {
  it('normalizes a delta counter into an exact observation', () => {
    const result = normalizeUsageEvents({ events: [event()] });
    expect(result.issues).toEqual([]);
    expect(result.observations).toHaveLength(1);
    const [observation] = result.observations;
    expect(observation?.quality).toBe('reported');
    expect(observation?.countsTowardTotal).toBe(true);
    expect(observation?.normalizationRuleVersion).toBe(NORMALIZATION_RULE_VERSION);
    expect(rationalFromExactQuantity(observation!.quantity)).toEqual(rational(100n));
  });

  it('treats a replayed source event as one call, not a new charge', () => {
    const result = normalizeUsageEvents({
      events: [event(), event()],
    });
    expect(result.observations).toHaveLength(1);
    expect(result.issues.map(issue => issue.code)).toEqual(['duplicate_event']);
  });

  it('does not re-meter a previously processed event key', () => {
    const result = normalizeUsageEvents({
      events: [event()],
      knownSourceEventKeys: ['planner#evt-1'],
    });
    expect(result.observations).toHaveLength(0);
    expect(result.issues[0]?.code).toBe('duplicate_event');
  });

  it('meters a genuine retry under a new call id as a separate charge', () => {
    const result = normalizeUsageEvents({
      events: [
        event(),
        event({
          sourceEventKey: 'evt-2',
          callId: 'call-2',
          reason: 'retry',
          counters: [{
            resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta', value: '100',
          }],
        }),
      ],
    });
    expect(totals(result)).toEqual([100n, 100n]);
    expect(result.observations[1]?.reason).toBe('retry');
  });

  it('diffs cumulative snapshots for the same call', () => {
    const first = normalizeUsageEvents({
      events: [event({
        counters: [{
          resource: 'model_tokens', metric: 'output', unit: 'token', kind: 'cumulative', value: '20',
        }],
      })],
    });
    expect(totals(first)).toEqual([20n]);
    const second = normalizeUsageEvents({
      events: [event({
        sourceEventKey: 'evt-2',
        counters: [{
          resource: 'model_tokens', metric: 'output', unit: 'token', kind: 'cumulative', value: '35',
        }],
      })],
      previousSnapshots: first.snapshots,
    });
    expect(totals(second)).toEqual([15n]);
    expect(second.snapshots).toEqual([{
      sourceId: 'planner', callId: 'call-1', metric: 'output', value: '35',
    }]);
  });

  it('ignores an unchanged cumulative snapshot', () => {
    const first = normalizeUsageEvents({
      events: [event({
        counters: [{
          resource: 'model_tokens', metric: 'output', unit: 'token', kind: 'cumulative', value: '35',
        }],
      })],
    });
    const second = normalizeUsageEvents({
      events: [event({
        sourceEventKey: 'evt-2',
        counters: [{
          resource: 'model_tokens', metric: 'output', unit: 'token', kind: 'cumulative', value: '35',
        }],
      })],
      previousSnapshots: first.snapshots,
    });
    expect(second.observations).toEqual([]);
    expect(second.issues).toEqual([]);
  });

  it('refuses to meter a counter reset without a new scope', () => {
    const result = normalizeUsageEvents({
      events: [event({
        sourceEventKey: 'evt-2',
        counters: [{
          resource: 'model_tokens', metric: 'output', unit: 'token', kind: 'cumulative', value: '5',
        }],
      })],
      previousSnapshots: [{ sourceId: 'planner', callId: 'call-1', metric: 'output', value: '35' }],
    });
    expect(result.observations).toEqual([]);
    expect(result.issues[0]?.code).toBe('counter_reset');
  });

  it('keeps cache and reasoning subsets out of the total', () => {
    const result = normalizeUsageEvents({
      events: [event({
        counters: [
          { resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta', value: '100' },
          {
            resource: 'model_tokens', metric: 'cache_read', unit: 'token', kind: 'delta',
            value: '80', subsetOf: 'input',
          },
          {
            resource: 'model_tokens', metric: 'reasoning', unit: 'token', kind: 'delta',
            value: '40', subsetOf: 'output',
          },
        ],
      })],
    });
    expect(result.observations).toHaveLength(3);
    expect(totals(result)).toEqual([100n]);
    expect(result.observations.filter(o => !o.countsTowardTotal)).toHaveLength(2);
  });

  it('sums only the authoritative coverage level per source', () => {
    const result = normalizeUsageEvents({
      events: [
        event({
          sourceScope: 'harness_turn',
          counters: [{
            resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta', value: '120',
          }],
        }),
        event({
          sourceEventKey: 'evt-2',
          sourceScope: 'model_request',
          counters: [{
            resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta', value: '120',
          }],
        }),
      ],
      authoritativeScopes: { planner: 'model_request' },
    });
    expect(result.observations).toHaveLength(2);
    expect(totals(result)).toEqual([120n]);
    expect(result.observations[0]?.countsTowardTotal).toBe(false);
  });

  it('records unavailable usage as missing, never as zero', () => {
    const result = normalizeUsageEvents({
      events: [event({
        counters: [],
        missing: [{ resource: 'model_tokens', metric: 'output', unit: 'token' }],
      })],
    });
    expect(result.issues[0]?.code).toBe('missing_usage');
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.quality).toBe('unavailable');
    expect(result.observations[0]?.countsTowardTotal).toBe(false);
    expect(totals(result)).toEqual([]);
  });

  it('rejects unsupported resources and malformed quantities without inventing cost', () => {
    const result = normalizeUsageEvents({
      events: [event({
        counters: [
          { resource: 'gpu_hour', metric: 'hour', unit: 'hour', kind: 'delta', value: '1' },
          { resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta', value: '-4' },
          { resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta', value: 'x' },
        ],
      })],
    });
    expect(result.observations).toEqual([]);
    expect(result.issues.map(issue => issue.code))
      .toEqual(['unsupported_resource', 'invalid_quantity', 'invalid_quantity']);
  });

  it('keeps fractional execution seconds exact', () => {
    const result = normalizeUsageEvents({
      events: [event({
        sourceId: 'runtime',
        sourceScope: 'resource_allocation',
        counters: [{
          resource: 'compute', metric: 'cpu_second', unit: 'second', kind: 'delta', value: '0.125',
        }],
      })],
    });
    expect(rationalFromExactQuantity(result.observations[0]!.quantity)).toEqual(rational(1n, 8n));
  });

  it('keeps concurrent Queries isolated', () => {
    const result = normalizeUsageEvents({
      events: [
        event({ queryId: 'query-a' }),
        event({ queryId: 'query-b', sourceEventKey: 'evt-b' }),
      ],
    });
    expect(result.observations.map(observation => observation.queryId)).toEqual(['query-a', 'query-b']);
  });
});
