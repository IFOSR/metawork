import { quotaForPlan, quotaWindowFor, type PlanQuotaDefinition } from './plan-quota.js';
import type { TokenUsageTotals } from './token-usage-service.js';

export type HostedQuotaDecision =
  | { readonly allowed: true; readonly remainingTokens: number; readonly usedTokens: number; readonly limit: number }
  | { readonly allowed: false; readonly reason: 'hosted_quota_exhausted' | 'unknown_plan' | 'usage_missing'; readonly usedTokens: number; readonly limit: number };

/**
 * Applies quotas only to Included/hosted calls. BYO and local calls must skip
 * this gate entirely. Missing usage never becomes zero: the caller can choose
 * to stop accepting hosted work until the missing fact is reconciled.
 */
export function decideHostedQuota(input: {
  readonly catalog: readonly PlanQuotaDefinition[];
  readonly planId: string;
  readonly now: Date;
  readonly trialStartedAt?: Date;
  readonly usage: TokenUsageTotals;
}): HostedQuotaDecision {
  const definition = quotaForPlan(input.catalog, input.planId);
  if (!definition) return { allowed: false, reason: 'unknown_plan', usedTokens: 0, limit: 0 };
  const window = quotaWindowFor(definition, { now: input.now, trialStartedAt: input.trialStartedAt });
  // The window is returned as part of the pure decision contract so callers
  // can persist the same boundary in a rollup; this check is intentionally
  // limited to the supplied aggregate.
  void window;
  if (input.usage.missingCalls > 0) {
    return { allowed: false, reason: 'usage_missing', usedTokens: 0, limit: definition.includedTokens };
  }
  const usedTokens = Number(BigInt(input.usage.inputTokens) + BigInt(input.usage.outputTokens));
  if (!Number.isSafeInteger(usedTokens)) {
    return { allowed: false, reason: 'hosted_quota_exhausted', usedTokens: Number.MAX_SAFE_INTEGER, limit: definition.includedTokens };
  }
  if (usedTokens >= definition.includedTokens) {
    return { allowed: false, reason: 'hosted_quota_exhausted', usedTokens, limit: definition.includedTokens };
  }
  return {
    allowed: true,
    remainingTokens: definition.includedTokens - usedTokens,
    usedTokens,
    limit: definition.includedTokens,
  };
}
