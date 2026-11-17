import { describe, expect, it, vi } from 'vitest';
import { EMPTY_WEB_USAGE, WebUsageService } from '../../src/metering/web-usage-service.js';
import { TokenUsageService } from '../../src/metering/token-usage-service.js';
import { createTokenUsageManagementQuery } from '../../src/management/token-usage-management.js';
import type { MeteringStore, ResourceUsageTotal } from '../../src/metering/ports.js';

function storeReturning(rows: ResourceUsageTotal[]) {
  return {
    summarizeResourceUsage: vi.fn(() => rows),
  } as unknown as Pick<MeteringStore, 'summarizeResourceUsage'>;
}

describe('WebUsageService', () => {
  it('counts billed search and fetch requests separately', () => {
    const store = storeReturning([
      { resource: 'search', metric: 'request', unit: 'request', quantity: '11', observations: 11 },
      { resource: 'tool_request', metric: 'request', unit: 'request', quantity: '18', observations: 18 },
    ]);
    const service = new WebUsageService(store);
    expect(service.totals({ accountId: 'account-1', from: '2026-11-14T00:00:00.000Z', to: '2026-11-15T00:00:00.000Z' }))
      .toEqual({ searchRequests: '11', fetchRequests: '18', totalRequests: '29', available: true });
    expect(store.summarizeResourceUsage).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-1',
      resources: ['search', 'tool_request'],
    }));
  });

  it('reports zero rather than a guess when nothing is recorded', () => {
    const service = new WebUsageService(storeReturning([]));
    expect(service.totals({ accountId: 'account-1', from: 'a', to: 'b' }))
      .toEqual({ searchRequests: '0', fetchRequests: '0', totalRequests: '0', available: true });
  });

  it('declares the projection unavailable when the store cannot summarize resources', () => {
    const service = new WebUsageService({} as Pick<MeteringStore, 'summarizeResourceUsage'>);
    expect(service.totals({ accountId: 'account-1', from: 'a', to: 'b' })).toBe(EMPTY_WEB_USAGE);
  });
});

describe('token usage management view', () => {
  const quota = {
    status: 'available' as const, planId: 'included-monthly', usedTokens: '0', includedTokens: '1000',
    remainingTokens: '1000', resetAt: '2026-12-01T00:00:00.000Z', providers: [],
  };
  const window = { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' };

  it('attaches billed web-tool requests to the same window as the Token timeline', () => {
    const usage = new TokenUsageService({
      listModelUsageFacts: () => [],
      iterateModelUsageFacts: () => [],
    } as unknown as Required<Pick<MeteringStore, 'listModelUsageFacts'>>);
    const webUsage = new WebUsageService(storeReturning([
      { resource: 'search', metric: 'request', unit: 'request', quantity: '3', observations: 3 },
    ]));
    const query = createTokenUsageManagementQuery({
      accountId: 'account-1', usage, webUsage,
      quotaContext: () => ({ quota, window }),
      now: () => new Date('2026-11-14T03:00:00.000Z'),
    });
    const view = query.read({ period: '7days' });
    expect(view.web).toEqual({
      searchRequests: '3', fetchRequests: '0', totalRequests: '3', available: true,
    });
    expect(view.range.start).toBe(view.range.start);
  });

  it('keeps the view readable when no web usage service is wired', () => {
    const usage = new TokenUsageService({
      listModelUsageFacts: () => [],
      iterateModelUsageFacts: () => [],
    } as unknown as Required<Pick<MeteringStore, 'listModelUsageFacts'>>);
    const query = createTokenUsageManagementQuery({
      accountId: 'account-1', usage,
      quotaContext: () => ({ quota, window }),
      now: () => new Date('2026-11-14T03:00:00.000Z'),
    });
    expect(query.read({ period: '7days' }).web).toEqual(EMPTY_WEB_USAGE);
  });
});
