import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { SqliteMeteringStore } from '../../src/storage/metering-repo.js';
import { SqliteQueryContextStore } from '../../src/storage/query-usage-context-repo.js';
import type { PersistedUsageObservation } from '../../src/metering/ports.js';

function observation(overrides: Partial<PersistedUsageObservation> & { observationId: string }): PersistedUsageObservation {
  return {
    observationId: overrides.observationId,
    spanId: null,
    sourceId: 'harness:pi:attempt-1',
    sourceEventKey: `tool_request:${overrides.observationId}`,
    sourceScope: 'harness_turn',
    callId: `tool:${overrides.observationId}`,
    queryId: 'query-1',
    executionSegmentId: 'attempt:attempt-1',
    taskId: 'task-1',
    stage: 'execution',
    reason: 'primary',
    resource: 'search',
    metric: 'request',
    unit: 'request',
    quantityNumerator: '1',
    quantityDenominator: '1',
    quality: 'reported',
    countsTowardTotal: true,
    payer: 'user_direct',
    capturedAt: '2026-11-14T10:00:00.000Z',
    providerBindingVersion: 'fingerprint',
    evidenceRef: 'attempt:attempt-1',
    normalizationRuleVersion: 'usage-normalizer-v1',
    ...overrides,
  };
}

describe('resource usage summary', () => {
  function setup() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    initializeDatabaseSchema(db);
    const contexts = new SqliteQueryContextStore(db);
    const metering = new SqliteMeteringStore(db);
    for (const [queryId, accountId] of [['query-1', 'account-1'], ['query-2', 'account-2']] as const) {
      contexts.insert({
        queryId, accountId, ingress: 'web', requestKey: `request-${queryId}`,
        requestPayloadDigest: 'digest', conversationId: null, requestId: `request-${queryId}`,
        turnId: null, executionSegmentId: null, acceptedAt: '2026-11-14T09:00:00.000Z',
      });
    }
    return { db, metering };
  }

  it('sums only billed resources inside the account window', () => {
    const { db, metering } = setup();
    metering.insertObservations([
      observation({ observationId: 'search-1' }),
      observation({ observationId: 'search-2' }),
      observation({ observationId: 'fetch-1', resource: 'tool_request' }),
      // Excluded: token facts, unavailable quality, replay-neutral flags, other accounts, out-of-window.
      observation({ observationId: 'tokens-1', resource: 'model_tokens', metric: 'input', unit: 'token', quantityNumerator: '900' }),
      observation({ observationId: 'unavailable-1', quality: 'unavailable', countsTowardTotal: false }),
      observation({ observationId: 'other-account', queryId: 'query-2' }),
      observation({ observationId: 'old', capturedAt: '2026-10-01T10:00:00.000Z' }),
    ]);

    const totals = metering.summarizeResourceUsage({
      accountId: 'account-1',
      from: '2026-11-14T00:00:00.000Z',
      to: '2026-11-15T00:00:00.000Z',
      resources: ['search', 'tool_request'],
    });

    expect(totals).toEqual([
      { resource: 'search', metric: 'request', unit: 'request', quantity: '2', observations: 2 },
      { resource: 'tool_request', metric: 'request', unit: 'request', quantity: '1', observations: 1 },
    ]);
    db.close();
  });

  it('refuses to sum fractional quantities as whole requests', () => {
    const { db, metering } = setup();
    metering.insertObservations([
      observation({ observationId: 'fractional', quantityNumerator: '1', quantityDenominator: '2' }),
      observation({ observationId: 'whole' }),
    ]);
    expect(metering.summarizeResourceUsage({
      accountId: 'account-1', from: '2026-11-14T00:00:00.000Z', to: '2026-11-15T00:00:00.000Z',
      resources: ['search'],
    })).toEqual([{ resource: 'search', metric: 'request', unit: 'request', quantity: '1', observations: 1 }]);
    db.close();
  });
});
