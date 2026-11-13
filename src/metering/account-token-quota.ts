import { quotaForPlan, quotaWindowFor, type PlanQuotaDefinition } from './plan-quota.js';
import { quotaGuidanceFor } from './quota-guidance.js';
import type { TokenUsageService } from './token-usage-service.js';

/** The same account-wide official usage drives both UI guidance and call preflight. */
export function readAccountTokenQuota(input: {
  accountId: string; usage: TokenUsageService; catalog: readonly PlanQuotaDefinition[];
  planId: string; now: Date; trialStartedAt?: Date;
}) {
  const definition = quotaForPlan(input.catalog, input.planId);
  if (!definition) throw new Error('usage_unknown_quota_plan');
  const window = quotaWindowFor(definition, input);
  const usage = input.usage.aggregate({ accountId: input.accountId, payer: 'platform', from: window.start, to: window.end });
  return { window, usage, quota: quotaGuidanceFor({ ...input, usage }) };
}
