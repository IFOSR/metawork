import { describe, expect, it, vi } from 'vitest';
import { createManagerQuotaPreflight } from '../../src/server/manager-quota-preflight.js';
import { createUsagePayerResolver } from '../../src/metering/usage-payer.js';
import type { RuntimeConfigurationView, ModelPolicy } from '../../src/configuration/types.js';
import type { PlanningContext } from '../../src/planning/planning-types.js';

const provider = { protocol: 'openai-compatible', baseUrl: 'https://example.test',
  apiKeyRef: 'file-secret:key', region: 'international', enabled: true } as const;
const old = { revisionId: 'old', providers: { same: provider, official: { ...provider, systemManaged: true } } };
const next = { revisionId: 'next', providers: { same: { ...provider, systemManaged: true }, official: provider } };

function context(policy: ModelPolicy = { mode: 'fixed', modelRef: 'byok' }): PlanningContext {
  return {
    userInput: 'continue', request: { sessionId: 'session', source: 'web' },
    pendingAuthorizationRequest: null, timeoutMs: 1000,
    configuration: { revisionId: 'old', contentHash: 'hash',
      models: [{ id: 'official', providerRef: 'official' }, { id: 'byok', providerRef: 'same' }] as never,
      planner: { harnessRef: 'manager', modelPolicy: policy }, routingCatalog: {} as never },
  };
}

describe('pinned provider ownership and Manager quota guidance', () => {
  it('keeps both directions of ownership changes pinned and leaves absent facts unknown', () => {
    const revisions = new Map<string, Pick<RuntimeConfigurationView, 'revisionId' | 'providers'>>([['old', old]]);
    const resolve = createUsagePayerResolver(revision => revisions.get(revision) ?? null);
    revisions.set('next', next);
    expect(resolve('same', 'old')).toBe('user_direct');
    expect(resolve('same', 'next')).toBe('platform');
    expect(resolve('official', 'old')).toBe('platform');
    expect(resolve('official', 'next')).toBe('user_direct');
    expect(resolve('same', 'missing')).toBe('unknown');
    expect(resolve('absent', 'old')).toBe('unknown');
    expect(resolve('constructor', 'old')).toBe('unknown');
    expect(resolve(null, 'old')).toBe('unknown');
    expect(createUsagePayerResolver(() => next)('same', 'old')).toBe('unknown');
  });

  it.each(['planning', 'permission'] as const)('skips Included reads for a BYOK %s call and clears stale notices', async purpose => {
    const readDecision = vi.fn(() => ({ allowed: false as const,
      reason: 'hosted_quota_exhausted' as const, usedTokens: 100, limit: 100 }));
    const loadConfiguration = vi.fn(async () => old);
    const preflight = createManagerQuotaPreflight({ loadConfiguration,
      resolveUsagePayer: createUsagePayerResolver(revision => revision === 'old' ? old : next), readDecision });
    const turn = context();
    turn.quotaNotice = { reason: 'hosted_quota_exhausted', usedTokens: '100', limit: 100, message: 'stale' };
    await preflight(turn, purpose);
    expect(turn.quotaNotice).toBeUndefined();
    expect(readDecision).not.toHaveBeenCalled();
    expect(loadConfiguration).toHaveBeenCalledWith('old');
  });

  it.each<ModelPolicy>([
    { mode: 'fixed', modelRef: 'official' },
    { mode: 'auto', allowedModelRefs: ['byok', 'official'], defaultModelRef: 'official' },
    { mode: 'auto', allowedModelRefs: ['official', 'byok'] },
  ])('uses the actual Manager model policy %j for hosted notices without blocking work', async policy => {
    const turn = context(policy);
    const preflight = createManagerQuotaPreflight({ loadConfiguration: async () => old,
      resolveUsagePayer: createUsagePayerResolver(() => old),
      readDecision: () => ({ allowed: false, reason: 'hosted_quota_exhausted', usedTokens: 100, limit: 100 }) });
    await expect(preflight(turn, 'planning')).resolves.toBeUndefined();
    expect(turn.quotaNotice).toMatchObject({ reason: 'hosted_quota_exhausted', usedTokens: '100' });
  });
});
