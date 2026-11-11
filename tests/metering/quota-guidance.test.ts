import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUOTA_CATALOG } from '../../src/metering/plan-quota.js';
import { quotaGuidanceFor } from '../../src/metering/quota-guidance.js';

const usage = (inputTokens: string, outputTokens: string, missingCalls = 0) => ({
  inputTokens, outputTokens, cacheReadTokens: '0', cacheWriteTokens: '0', reasoningTokens: '0',
  calls: 1, missingCalls,
});

describe('quota guidance', () => {
  it('returns a quiet available state with remaining tokens', () => {
    const result = quotaGuidanceFor({
      catalog: DEFAULT_PLAN_QUOTA_CATALOG,
      planId: 'free-baseline',
      now: new Date('2026-11-09T00:00:00.000Z'),
      usage: usage('10', '20'),
    });
    expect(result).toMatchObject({ status: 'available', usedTokens: '30', remainingTokens: '999970' });
  });

  it('returns the maintained provider directory when Included quota is exhausted', () => {
    const result = quotaGuidanceFor({
      catalog: DEFAULT_PLAN_QUOTA_CATALOG,
      planId: 'free-baseline',
      now: new Date('2026-11-09T00:00:00.000Z'),
      usage: usage('1000000', '0'),
    });
    expect(result.status).toBe('exhausted');
    expect(result.providers.length).toBeGreaterThan(0);
    expect(result.providers[0]).toMatchObject({
      id: 'metafusion-meta-router',
      url: 'https://airouter.metafusion.cn/',
      logoUrl: '/provider-metafusion.png',
    });
  });

  it('keeps task guidance available when token facts are temporarily missing', () => {
    const result = quotaGuidanceFor({
      catalog: DEFAULT_PLAN_QUOTA_CATALOG,
      planId: 'free-baseline',
      now: new Date('2026-11-09T00:00:00.000Z'),
      usage: usage('0', '0', 1),
    });
    expect(result.status).toBe('usage_unavailable');
    expect(result.message).toContain('不会被阻断');
  });
});
