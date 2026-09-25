/**
 * 覆盖率投影（ADR-0042 §4；实施计划 §4.3）。
 *
 * 覆盖率回答“这个 Query 的用量是否完整”，质量标记回答“每条观测可信到什么
 * 程度”。两者都用于展示、影子统计和最终单的完整性声明，缺失绝不填零。
 */

import type { BillingResource } from '../billing/pricing.js';
import type { UsageObservation, UsageQuality } from './contracts.js';

export interface ExpectedUsageCategory {
  readonly resource: BillingResource;
  readonly metric: string;
}

export type CoverageLevel = 'complete' | 'partial' | 'incomplete';

export interface CoverageReport {
  readonly quality: UsageQuality;
  readonly coverage: CoverageLevel;
  readonly observedCategories: readonly string[];
  readonly estimatedCategories: readonly string[];
  readonly unavailableCategories: readonly string[];
  readonly missingCategories: readonly string[];
  readonly observedCount: number;
  readonly missingCount: number;
  readonly note: string | null;
}

function categoryKey(category: ExpectedUsageCategory): string {
  return `${category.resource}:${category.metric}`;
}

export function projectCoverage(input: {
  readonly observations: readonly UsageObservation[];
  readonly expected: readonly ExpectedUsageCategory[];
}): CoverageReport {
  const byCategory = new Map<string, UsageObservation[]>();
  for (const observation of input.observations) {
    const key = `${observation.resource}:${observation.metric}`;
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(observation);
    else byCategory.set(key, [observation]);
  }
  const observed: string[] = [];
  const estimated: string[] = [];
  const unavailable: string[] = [];
  const missing: string[] = [];
  // 期望集合为空时，凡有观测就算覆盖；没有值得说明的缺失类别。
  const expectedKeys = input.expected.map(categoryKey);
  for (const key of expectedKeys) {
    const bucket = byCategory.get(key) ?? [];
    if (bucket.length === 0) {
      missing.push(key);
      continue;
    }
    if (bucket.every(entry => entry.quality === 'unavailable')) {
      unavailable.push(key);
      continue;
    }
    observed.push(key);
    if (bucket.some(entry => entry.quality === 'estimated')) estimated.push(key);
  }
  if (input.expected.length === 0) {
    for (const key of byCategory.keys()) observed.push(key);
  }
  const missingCount = missing.length + unavailable.length;
  const coverage: CoverageLevel = missingCount > 0
    ? 'incomplete'
    : estimated.length > 0
      ? 'partial'
      : 'complete';
  const quality: UsageQuality = observed.length === 0 && input.expected.length > 0
    ? 'unavailable'
    : estimated.length > 0 || unavailable.length > 0
      ? 'estimated'
      : 'reported';
  const note = missingCount > 0
    ? `${missingCount} usage category(ies) have no trusted measurement`
    : estimated.length > 0
      ? `${estimated.length} usage category(ies) are estimated`
      : null;
  return Object.freeze({
    quality,
    coverage,
    observedCategories: Object.freeze([...observed].sort()),
    estimatedCategories: Object.freeze([...estimated].sort()),
    unavailableCategories: Object.freeze([...unavailable].sort()),
    missingCategories: Object.freeze([...missing].sort()),
    observedCount: observed.length + estimated.length + unavailable.length,
    missingCount,
    note,
  });
}

/** 合并同一 Query 多个执行段的覆盖率，取最保守的结论。 */
export function mergeCoverage(reports: readonly CoverageReport[]): CoverageReport {
  if (reports.length === 0) {
    return Object.freeze({
      quality: 'unavailable',
      coverage: 'incomplete',
      observedCategories: [],
      estimatedCategories: [],
      unavailableCategories: [],
      missingCategories: [],
      observedCount: 0,
      missingCount: 0,
      note: 'no metering coverage was recorded',
    });
  }
  const union = (pick: (report: CoverageReport) => readonly string[]): readonly string[] => (
    Object.freeze([...new Set(reports.flatMap(pick))].sort())
  );
  const missing = union(report => report.missingCategories);
  const unavailable = union(report => report.unavailableCategories);
  const estimated = union(report => report.estimatedCategories);
  const observed = union(report => report.observedCategories);
  const missingCount = reports.reduce((sum, report) => sum + report.missingCount, 0);
  const hasUnavailable = reports.some(report => report.quality === 'unavailable');
  const hasEstimated = reports.some(report => report.quality === 'estimated');
  const coverage: CoverageLevel = missingCount > 0 || unavailable.length > 0
    ? 'incomplete'
    : hasEstimated || estimated.length > 0
      ? 'partial'
      : 'complete';
  return Object.freeze({
    quality: hasUnavailable ? 'unavailable' : hasEstimated || estimated.length > 0 ? 'estimated' : 'reported',
    coverage,
    observedCategories: observed,
    estimatedCategories: estimated,
    unavailableCategories: unavailable,
    missingCategories: missing,
    observedCount: reports.reduce((sum, report) => sum + report.observedCount, 0),
    missingCount,
    note: coverage === 'complete'
      ? null
      : reports.find(report => report.note !== null)?.note ?? null,
  });
}

/** 只有 `complete` 且来源为 `reported` 的覆盖率才能支撑最终单。 */
export function isChargeableCoverage(report: CoverageReport): boolean {
  return report.coverage === 'complete' && report.quality === 'reported';
}
