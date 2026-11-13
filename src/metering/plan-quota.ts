/**
 * Hosted-model token allowances per plan (ADR-0055 D4/D5).
 *
 * Only two subscription periods exist: monthly and yearly. A trial is the single
 * exception: it is a fixed-length allowance that is not a subscription period and
 * never renews. Metering records tokens only; there are no prices, no money and
 * no per-call cost here.
 *
 * The numbers below are product placeholders chosen so the surfaces have
 * something real to display. They are the single place to change: every consumer
 * reads this catalog, and `resolvePlanQuotaCatalog` lets an operator override
 * one plan without touching code.
 *
 * Quota exhaustion rejects *hosted* calls only (D5): local models and non-model
 * work keep running, and the client shows a guided upgrade path.
 */

export const PLAN_QUOTA_PERIODS = ['monthly', 'yearly'] as const;
export type PlanQuotaPeriod = (typeof PLAN_QUOTA_PERIODS)[number];

/** Trial is deliberately not a `PlanQuotaPeriod`. */
export const TRIAL_PLAN_ID = 'trial';
export const TRIAL_PERIOD_DAYS = 7;
export const TRIAL_INCLUDED_TOKENS = 1_000_000;

export interface PlanQuotaDefinition {
  /** Stable plan identifier used by account entitlement records. */
  readonly planId: string;
  readonly billingPeriod: PlanQuotaPeriod | 'trial';
  /** Hosted model tokens included per window. 0 means "no hosted allowance". */
  readonly includedTokens: number;
  /** Trial length in days; only valid for `billingPeriod: 'trial'`. */
  readonly trialDays?: number;
  /** ISO date from which this definition applies. */
  readonly effectiveFrom: string;
  readonly description: string;
}

/**
 * Placeholder catalog. Change these values (or override them) to reprice the
 * product; nothing else in the codebase hard-codes a token amount.
 */
export const DEFAULT_PLAN_QUOTA_CATALOG: readonly PlanQuotaDefinition[] = Object.freeze([
  {
    planId: 'free-baseline',
    billingPeriod: 'monthly',
    includedTokens: 1_000_000,
    effectiveFrom: '2026-11-01',
    description: '免费基线：未订阅时的每月官方托管模型额度',
  },
  {
    planId: 'included-monthly',
    billingPeriod: 'monthly',
    includedTokens: 20_000_000,
    effectiveFrom: '2026-11-01',
    description: 'Included 月付：每个自然月官方托管模型额度',
  },
  {
    planId: 'included-yearly',
    billingPeriod: 'yearly',
    includedTokens: 240_000_000,
    effectiveFrom: '2026-11-01',
    description: 'Included 年付：每个自然年官方托管模型额度（约为月付的 12 倍）',
  },
  {
    planId: TRIAL_PLAN_ID,
    billingPeriod: 'trial',
    includedTokens: TRIAL_INCLUDED_TOKENS,
    trialDays: TRIAL_PERIOD_DAYS,
    effectiveFrom: '2026-11-01',
    description: '试用：一次性 7 天 1,000,000 token 额度，不属于订阅周期，不续期',
  },
]);

export interface QuotaWindow {
  readonly start: string;
  readonly end: string;
}

export function validatePlanQuotaDefinition(definition: PlanQuotaDefinition): void {
  if (!definition.planId.trim()) throw new Error('plan quota requires a planId');
  if (!Number.isSafeInteger(definition.includedTokens) || definition.includedTokens < 0) {
    throw new Error(`plan quota ${definition.planId}: includedTokens must be a non-negative integer`);
  }
  if (definition.billingPeriod === 'trial') {
    if (!Number.isSafeInteger(definition.trialDays) || (definition.trialDays ?? 0) <= 0) {
      throw new Error(`plan quota ${definition.planId}: trial requires a positive trialDays`);
    }
  } else if (definition.trialDays !== undefined) {
    throw new Error(
      `plan quota ${definition.planId}: trialDays is only valid for the trial plan; `
      + 'subscribe periods are monthly or yearly',
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(definition.effectiveFrom)) {
    throw new Error(`plan quota ${definition.planId}: effectiveFrom must be YYYY-MM-DD`);
  }
  if (!definition.description.trim()) {
    throw new Error(`plan quota ${definition.planId}: description must not be empty`);
  }
}

/**
 * Overrides replace defaults by `planId`; a plan missing from the overrides keeps
 * its default. Unknown extra plans are appended so a deployment can add a plan
 * without a code change.
 */
export function resolvePlanQuotaCatalog(
  overrides: readonly PlanQuotaDefinition[] = [],
): readonly PlanQuotaDefinition[] {
  for (const override of overrides) validatePlanQuotaDefinition(override);
  const resolved = new Map<string, PlanQuotaDefinition>();
  for (const definition of DEFAULT_PLAN_QUOTA_CATALOG) {
    validatePlanQuotaDefinition(definition);
    resolved.set(definition.planId, definition);
  }
  for (const override of overrides) resolved.set(override.planId, override);
  return [...resolved.values()];
}

export function quotaForPlan(
  catalog: readonly PlanQuotaDefinition[],
  planId: string,
): PlanQuotaDefinition | null {
  return catalog.find(definition => definition.planId === planId) ?? null;
}

/** Free baseline applies when the account holds no subscription plan. */
export function baselineQuotaFor(catalog: readonly PlanQuotaDefinition[]): PlanQuotaDefinition | null {
  return quotaForPlan(catalog, 'free-baseline');
}

/**
 * Calendar windows are computed by Beijing calendar dates (UTC+08:00), then
 * represented as UTC instants for the half-open usage query.
 * A trial window starts at activation and lasts `trialDays`.
 */
export function quotaWindowFor(
  definition: PlanQuotaDefinition,
  input: { now: Date; trialStartedAt?: Date },
): QuotaWindow {
  if (definition.billingPeriod === 'trial') {
    const startedAt = input.trialStartedAt;
    if (!startedAt) throw new Error(`plan quota ${definition.planId}: trial requires trialStartedAt`);
    const end = new Date(startedAt.getTime() + (definition.trialDays ?? 0) * 86_400_000);
    return { start: startedAt.toISOString(), end: end.toISOString() };
  }
  // Asia/Shanghai has a fixed UTC+08:00 offset. Shift the instant before
  // reading calendar fields, then shift the boundary back to a UTC instant.
  const beijingNow = new Date(input.now.getTime() + 8 * 60 * 60 * 1000);
  const year = beijingNow.getUTCFullYear();
  const month = beijingNow.getUTCMonth();
  const utcBoundary = (boundaryYear: number, boundaryMonth: number): string => (
    new Date(Date.UTC(boundaryYear, boundaryMonth, 1) - 8 * 60 * 60 * 1000).toISOString()
  );
  if (definition.billingPeriod === 'yearly') {
    return {
      start: utcBoundary(year, 0),
      end: utcBoundary(year + 1, 0),
    };
  }
  return {
    start: utcBoundary(year, month),
    end: utcBoundary(year, month + 1),
  };
}
