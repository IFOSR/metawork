import type { QuotaWindow } from '../metering/plan-quota.js';
import type { QuotaGuidance } from '../metering/quota-guidance.js';
import type { TokenUsageService } from '../metering/token-usage-service.js';
import { EMPTY_WEB_USAGE, type WebUsageService, type WebUsageTotals } from '../metering/web-usage-service.js';
import { resolveUsageRange, type UsageTimelineRequest, type TokenUsageTimeline } from '../metering/token-usage-timeline.js';

export interface TokenUsageView extends TokenUsageTimeline {
  quota: QuotaGuidance;
  quotaWindow: QuotaWindow;
  /**
   * Billed web-tool requests (Executor `web_search`/`web_fetch` against a metered
   * backend) in the same window as the Token timeline.
   */
  web: WebUsageTotals;
}
/** Account identity is bound by Server composition, never by request parameters. */
export function createTokenUsageManagementQuery(deps: {
  accountId: string;
  usage: TokenUsageService;
  webUsage?: WebUsageService;
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
      const web = deps.webUsage
        ? deps.webUsage.totals({ accountId: deps.accountId, from: range.from, to: range.to })
        : EMPTY_WEB_USAGE;
      return {
        ...deps.usage.timeline(
          { accountId: deps.accountId, from: range.from, to: range.to },
          range,
          input.groupBy === 'provider' ? 'provider' : 'model',
        ),
        quota,
        quotaWindow: window,
        web,
      };
    },
  };
}
export type TokenUsageManagementQuery = ReturnType<typeof createTokenUsageManagementQuery>;
