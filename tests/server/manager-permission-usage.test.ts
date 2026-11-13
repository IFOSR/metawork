import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagerPermissionUsageRecorder } from '../../src/server/manager-permission-usage.js';
import { createUsagePayerResolver } from '../../src/metering/usage-payer.js';
import { createUsageRecorder } from '../../src/metering/usage-service.js';
import { TokenUsageService } from '../../src/metering/token-usage-service.js';
import { readAccountTokenQuota } from '../../src/metering/account-token-quota.js';
import { DEFAULT_PLAN_QUOTA_CATALOG } from '../../src/metering/plan-quota.js';
import { beginQuery, createMeteringHarness, type MeteringHarness } from '../support/metering-harness.js';

let harness: MeteringHarness | undefined;
afterEach(() => { harness?.close(); harness = undefined; });

describe('Manager permission usage composition', () => {
  it('keeps an in-flight BYOK permission call outside Included after the same provider becomes official', () => {
    harness = createMeteringHarness();
    beginQuery(harness, { queryId: 'query', accountId: 'account' });
    const provider = { protocol: 'openai-compatible', baseUrl: 'https://example.test',
      apiKeyRef: 'file-secret:key', region: 'international', enabled: true } as const;
    const previous = { revisionId: 'previous', providers: { shared: provider } };
    const next = { revisionId: 'next', providers: { shared: { ...provider, systemManaged: true } } };
    const record = createManagerPermissionUsageRecorder({
      recorder: createUsageRecorder({ metering: harness.metering }),
      resolveUsagePayer: createUsagePayerResolver(revision => revision === 'previous' ? previous : next),
    });
    const usage = { sourceEventKey: 'event', callId: 'call', providerRef: 'shared',
      counters: [{ resource: 'model_tokens' as const, metric: 'input', unit: 'token', value: '12' },
        { resource: 'model_tokens' as const, metric: 'output', unit: 'token', value: '5' }] };
    record({ queryId: 'query', taskId: 'task', requestId: 'old-call', configurationRevision: 'previous', usage });
    record({ queryId: 'query', taskId: 'task', requestId: 'new-call', configurationRevision: 'next', usage });
    const tokens = new TokenUsageService(harness.metering);
    const quota = readAccountTokenQuota({ accountId: 'account', usage: tokens,
      catalog: DEFAULT_PLAN_QUOTA_CATALOG, planId: 'free-baseline', now: new Date() });
    expect(quota.quota.usedTokens).toBe('17');
    expect(tokens.aggregate({ accountId: 'account', payer: 'user_direct',
      from: quota.window.start, to: quota.window.end })).toMatchObject({ inputTokens: '12', outputTokens: '5', calls: 1 });
  });

  it('persists provider-specific payer and deduplicates retries without charging BYOK to Included', () => {
    harness = createMeteringHarness();
    beginQuery(harness, { queryId: 'query', accountId: 'account' });
    const resolveUsagePayer = vi.fn((providerRef: string | null | undefined) =>
      providerRef === 'official' ? 'platform' as const : 'user_direct' as const);
    const record = createManagerPermissionUsageRecorder({
      recorder: createUsageRecorder({ metering: harness.metering }), resolveUsagePayer,
    });
    const event = {
      queryId: 'query', taskId: 'task', requestId: 'permission-1', configurationRevision: 'config-1',
      usage: {
        sourceEventKey: 'event', callId: 'call', providerRef: 'byok', modelId: 'model', agentClassRef: 'manager',
        counters: [
          { resource: 'model_tokens' as const, metric: 'input', unit: 'token', value: '12' },
          { resource: 'model_tokens' as const, metric: 'output', unit: 'token', value: '5' },
        ],
      },
    };
    record(event);
    record(event);
    // Upstream call IDs can be reused by separate permission sessions.
    record({ ...event, requestId: 'permission-2', usage: { ...event.usage, providerRef: 'official' } });
    expect(resolveUsagePayer.mock.calls).toEqual([['byok', 'config-1'], ['byok', 'config-1'], ['official', 'config-1']]);
    const observations = harness.metering.listObservations('query');
    expect(observations).toHaveLength(4);
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: 'permission-1:call', payer: 'user_direct',
        providerBindingVersion: 'config-1', evidenceRef: 'permission:permission-1', taskId: 'task' }),
      expect.objectContaining({ callId: 'permission-2:call', payer: 'platform' }),
    ]));
    const usage = new TokenUsageService(harness.metering);
    const quota = readAccountTokenQuota({ accountId: 'account', usage,
      catalog: DEFAULT_PLAN_QUOTA_CATALOG, planId: 'free-baseline', now: new Date() });
    expect(quota.quota.usedTokens).toBe('17');
    expect(usage.aggregate({ accountId: 'account', payer: 'user_direct',
      from: quota.window.start, to: quota.window.end })).toMatchObject({ inputTokens: '12', outputTokens: '5', calls: 1 });
  });
});
