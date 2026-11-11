import type { QuotaWindow } from '../metering/plan-quota.js';
import type { QuotaGuidance } from '../metering/quota-guidance.js';
import type { TokenUsageService } from '../metering/token-usage-service.js';
import { resolveUsageRange, type UsageTimelineRequest, type TokenUsageTimeline } from '../metering/token-usage-timeline.js';

export interface TokenUsageView extends TokenUsageTimeline {
  quota: QuotaGuidance;
  quotaWindow: QuotaWindow;
}
/** Account identity is bound by Server composition, never by request parameters. */
export function createTokenUsageManagementQuery(deps: {
  accountId: string;
  usage: TokenUsageService;
  quotaContext: (now: Date) => { quota: QuotaGuidance; window: QuotaWindow };
  now?: () => Date;
}) {
  return {
    read(input: UsageTimelineRequest): TokenUsageView {
      const now = deps.now?.() ?? new Date();
      // Validate caller input before reading the account's quota or usage.
      if (input.period !== 'subscription') resolveUsageRange(input, now);
      const { quota, window } = deps.quotaContext(now);
      const range = resolveUsageRange(input, now, window);
      return { ...deps.usage.timeline({ accountId: deps.accountId, from: range.from, to: range.to }, range, input.groupBy === 'provider' ? 'provider' : 'model'), quota, quotaWindow: window };
    },
  };
}
export type TokenUsageManagementQuery = ReturnType<typeof createTokenUsageManagementQuery>;
