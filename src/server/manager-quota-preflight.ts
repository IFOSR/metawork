import type { UsagePayerResolver } from '../metering/usage-payer.js';
import type { HostedQuotaDecision } from '../metering/quota-enforcement.js';
import type { PlanningContext } from '../planning/planning-types.js';
import { selectManagerModel } from '../planning/manager-host/manager-planning-agent.js';

/** Quota guidance follows the same pinned model selection as the actual call. */
export function createManagerQuotaPreflight(deps: {
  loadConfiguration(revision: string): Promise<unknown>;
  resolveUsagePayer: UsagePayerResolver;
  readDecision(): HostedQuotaDecision;
  onNotice?(purpose: 'planning' | 'permission', decision: Extract<HostedQuotaDecision, { allowed: false }>): void;
}) {
  return async (context: PlanningContext, purpose: 'planning' | 'permission'): Promise<void> => {
    delete context.quotaNotice;
    await deps.loadConfiguration(context.configuration.revisionId);
    const providerRef = selectManagerModel(context).providerRef;
    if (deps.resolveUsagePayer(providerRef, context.configuration.revisionId) !== 'platform') return;
    const decision = deps.readDecision();
    if (decision.allowed) return;
    context.quotaNotice = {
      reason: decision.reason,
      usedTokens: String(decision.usedTokens),
      limit: decision.limit,
      message: decision.reason === 'usage_missing'
        ? `Hosted token usage is temporarily unavailable; the current Included allowance is ${decision.limit} tokens.`
        : decision.reason === 'unknown_plan'
          ? 'The hosted plan is not recognized; Included allowance could not be determined.'
          : `The Included hosted allowance is exhausted (${decision.usedTokens}/${decision.limit} tokens). Configure a user-owned Provider or consult the available provider directory to continue beyond the Included allowance.`,
    };
    deps.onNotice?.(purpose, decision);
  };
}
