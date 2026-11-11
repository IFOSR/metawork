import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAN_QUOTA_CATALOG,
  TRIAL_PLAN_ID,
  baselineQuotaFor,
  quotaForPlan,
  quotaWindowFor,
  resolvePlanQuotaCatalog,
  validatePlanQuotaDefinition,
  type PlanQuotaDefinition,
} from '../../src/metering/plan-quota.js';

// ADR-0055 D4/D5: two subscription periods plus a trial exception, token
// allowances only, quota exhaustion rejects hosted calls only.
describe('plan quota catalog', () => {
  it('ships two subscription periods and a trial exception', () => {
    const periods = DEFAULT_PLAN_QUOTA_CATALOG.map(definition => definition.billingPeriod);
    expect(periods.filter(period => period === 'monthly').length).toBeGreaterThan(0);
    expect(periods.filter(period => period === 'yearly').length).toBeGreaterThan(0);
    expect(periods.filter(period => period === 'trial')).toEqual(['trial']);
    expect(periods.every(period => ['monthly', 'yearly', 'trial'].includes(period))).toBe(true);
  });

  it('has a free baseline and a trial that never counts as a subscription', () => {
    const baseline = baselineQuotaFor(DEFAULT_PLAN_QUOTA_CATALOG);
    expect(baseline?.planId).toBe('free-baseline');
    expect(baseline?.includedTokens).toBeGreaterThanOrEqual(0);
    const trial = quotaForPlan(DEFAULT_PLAN_QUOTA_CATALOG, TRIAL_PLAN_ID);
    expect(trial).toMatchObject({ billingPeriod: 'trial' });
    expect(trial?.trialDays).toBe(7);
    expect(trial?.includedTokens).toBe(1_000_000);
    expect(trial?.trialDays).toBeDefined();
    expect('billingPeriod' in (trial ?? {}) && trial?.billingPeriod !== 'monthly').toBe(true);
  });

  it.each(DEFAULT_PLAN_QUOTA_CATALOG.map(definition => [definition.planId, definition] as const))(
    'accepts the shipped definition for %s',
    (_planId, definition) => {
      expect(() => validatePlanQuotaDefinition(definition)).not.toThrow();
    },
  );

  it('rejects negative, fractional and trial-shaped subscription allowances', () => {
    const base: PlanQuotaDefinition = {
      planId: 'x', billingPeriod: 'monthly', includedTokens: 10,
      effectiveFrom: '2026-11-01', description: 'x',
    };
    expect(() => validatePlanQuotaDefinition({ ...base, includedTokens: -1 })).toThrow(/non-negative/u);
    expect(() => validatePlanQuotaDefinition({ ...base, includedTokens: 1.5 })).toThrow(/non-negative/u);
    expect(() => validatePlanQuotaDefinition({ ...base, trialDays: 7 })).toThrow(/only valid for the trial/u);
    expect(() => validatePlanQuotaDefinition({ ...base, billingPeriod: 'trial' })).toThrow(/positive trialDays/u);
    expect(() => validatePlanQuotaDefinition({ ...base, effectiveFrom: '2026/11/01' })).toThrow(/effectiveFrom/u);
    expect(() => validatePlanQuotaDefinition({ ...base, description: ' ' })).toThrow(/description/u);
  });

  it('lets an operator override one plan and keeps the rest', () => {
    const catalog = resolvePlanQuotaCatalog([{
      planId: 'included-monthly',
      billingPeriod: 'monthly',
      includedTokens: 42,
      effectiveFrom: '2026-12-01',
      description: 'override',
    }]);
    expect(quotaForPlan(catalog, 'included-monthly')?.includedTokens).toBe(42);
    expect(quotaForPlan(catalog, 'included-yearly')?.includedTokens)
      .toBe(quotaForPlan(DEFAULT_PLAN_QUOTA_CATALOG, 'included-yearly')?.includedTokens);
    expect(quotaForPlan(catalog, 'free-baseline')).not.toBeNull();
  });

  it('fails on an invalid override instead of silently keeping defaults', () => {
    expect(() => resolvePlanQuotaCatalog([{
      planId: 'included-monthly',
      billingPeriod: 'monthly',
      includedTokens: -5,
      effectiveFrom: '2026-12-01',
      description: 'bad',
    }])).toThrow(/non-negative/u);
  });

  it('computes Beijing calendar windows as UTC instants for monthly and yearly plans', () => {
    const monthly = quotaWindowFor(
      quotaForPlan(DEFAULT_PLAN_QUOTA_CATALOG, 'included-monthly')!,
      { now: new Date('2026-12-15T10:00:00.000Z') },
    );
    expect(monthly).toEqual({
      start: '2026-11-30T16:00:00.000Z',
      end: '2026-12-31T16:00:00.000Z',
    });
    const yearly = quotaWindowFor(
      quotaForPlan(DEFAULT_PLAN_QUOTA_CATALOG, 'included-yearly')!,
      { now: new Date('2026-12-15T10:00:00.000Z') },
    );
    expect(yearly).toEqual({
      start: '2025-12-31T16:00:00.000Z',
      end: '2026-12-31T16:00:00.000Z',
    });
  });

  it('places the Beijing month boundary correctly around UTC midnight', () => {
    const monthly = quotaWindowFor(
      quotaForPlan(DEFAULT_PLAN_QUOTA_CATALOG, 'included-monthly')!,
      { now: new Date('2026-11-30T17:00:00.000Z') },
    );
    expect(monthly.start).toBe('2026-11-30T16:00:00.000Z');
    expect(monthly.end).toBe('2026-12-31T16:00:00.000Z');
  });

  it('computes the trial window from activation and requires it', () => {
    const trial = quotaForPlan(DEFAULT_PLAN_QUOTA_CATALOG, TRIAL_PLAN_ID)!;
    const window = quotaWindowFor(trial, {
      now: new Date('2026-11-07T00:00:00.000Z'),
      trialStartedAt: new Date('2026-11-07T00:00:00.000Z'),
    });
    expect(window.start).toBe('2026-11-07T00:00:00.000Z');
    expect(window.end).toBe('2026-11-14T00:00:00.000Z');
    expect(() => quotaWindowFor(trial, { now: new Date() })).toThrow(/trialStartedAt/u);
  });
});
