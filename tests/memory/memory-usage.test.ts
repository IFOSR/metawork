import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryUsageDrainer } from '../../src/memory/memory-usage.js';
import type { MemoryEngineUsage } from '../../src/memory/memory-types.js';
import { createQueryContextService } from '../../src/metering/query-context-service.js';
import { createUsageRecorder } from '../../src/metering/usage-service.js';
import { TokenUsageService } from '../../src/metering/token-usage-service.js';
import { beginQuery, createMeteringHarness, type MeteringHarness } from '../support/metering-harness.js';

const call = (overrides: Partial<MemoryEngineUsage> = {}): MemoryEngineUsage => ({
  instanceId: 'engine-1',
  seq: 1,
  occurredAt: '2026-11-10T00:00:00.000Z',
  model: 'extraction-model',
  inputTokens: 120,
  outputTokens: 30,
  success: true,
  error: null,
  ...overrides,
});

let harness: MeteringHarness | undefined;
let queryOrdinal = 0;
afterEach(() => { harness?.close(); queryOrdinal = 0; });

function setup(input: {
  calls: readonly MemoryEngineUsage[];
  payer?: 'platform' | 'user_direct' | 'unknown';
}) {
  harness = createMeteringHarness();
  const events: unknown[] = [];
  const drainer = createMemoryUsageDrainer({
    accountId: 'a',
    drainUsage: async () => input.calls,
    // The drainer creates (and then reuses) the account-level system Query.
    queryLifecycle: createQueryContextService({
      store: harness.contexts,
      createQueryId: () => `memory-query-${++queryOrdinal}`,
    }),
    usageObserver: event => {
      events.push(event);
      createUsageRecorder({ metering: harness!.metering }).record(event);
    },
    resolveUsagePayer: () => input.payer ?? 'platform',
    configurationRevision: 'revision-1',
    providerRef: 'memory-provider',
    modelRef: 'extraction-model',
    now: () => new Date('2026-11-10T00:00:00.000Z'),
  });
  return { drainer, events, metering: harness.metering, harness, drainAgain: () => drainer.drain() };
}

describe('memory engine usage drain', () => {
  it('records each engine call as one account-bound memory fact', async () => {
    const { drainer, metering } = setup({ calls: [call(), call({ seq: 2, inputTokens: 40, outputTokens: 10 })] });
    expect(await drainer.drain()).toBe(2);
    const usage = new TokenUsageService(metering);
    const facts = usage.list({ accountId: 'a' }).sort((left, right) => left.callIdempotencyKey.localeCompare(right.callIdempotencyKey));
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      queryId: 'memory-query-1',
      providerRef: 'memory-provider',
      modelId: 'extraction-model',
      agentClassRef: 'memory',
      payer: 'platform',
      sourceId: 'memory',
      inputTokens: '120',
      outputTokens: '30',
      usageSource: 'reported',
    });
  });

  it('resolves the payer from the extraction Provider ownership', async () => {
    const { drainer, metering } = setup({ calls: [call()], payer: 'user_direct' });
    await drainer.drain();
    const facts = new TokenUsageService(metering).list({ accountId: 'a' });
    expect(facts[0]).toMatchObject({ payer: 'user_direct' });
  });

  it('keeps a failed engine call visible with missing usage instead of zero', async () => {
    const { drainer, metering } = setup({
      calls: [call({ inputTokens: null, outputTokens: null, success: false, error: 'timeout' })],
    });
    await drainer.drain();
    const facts = new TokenUsageService(metering).list({ accountId: 'a' });
    expect(facts[0]).toMatchObject({
      inputTokens: null, outputTokens: null, usageSource: 'provider_unavailable',
    });
  });

  it('writes nothing when there is no account-bound Query to attribute the call to', async () => {
    harness = createMeteringHarness();
    const events: unknown[] = [];
    const drainer = createMemoryUsageDrainer({
      accountId: 'a',
      drainUsage: async () => [call()],
      usageObserver: event => events.push(event),
      configurationRevision: 'revision-1',
      providerRef: 'memory-provider',
      modelRef: 'extraction-model',
    });
    expect(await drainer.drain()).toBe(0);
    expect(events).toEqual([]);
  });

  it('does not double count the same engine call identity', async () => {
    // A duplicated delivery of the same engine identity (same instance +
    // sequence) is one call: the observation insert is idempotent and the fact
    // keeps one identity.
    const { drainer, metering } = setup({ calls: [call()] });
    await drainer.drain();
    await drainer.drain();
    const facts = new TokenUsageService(metering).list({ accountId: 'a' });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.inputTokens).toBe('120');
  });
});
