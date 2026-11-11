import type { ModelUsageFact } from './ports.js';
import type { QuotaWindow } from './plan-quota.js';
import { isUsageTimestamp } from './token-usage-filter.js';

const DAY = 86_400_000;
const BEIJING_OFFSET = 8 * 3_600_000;
export const USAGE_PERIODS = ['today', 'week', '7days', '30days', 'month', 'lastMonth', 'subscription', 'custom'] as const;
export type UsagePeriod = typeof USAGE_PERIODS[number];
export type UsageGroup = 'model' | 'provider';
export interface UsageTimelineRequest { period?: string; groupBy?: string; start?: string; end?: string }
export class UsageRangeError extends Error {}
export interface UsageRange { from: string; to: string; start: string; end: string }
export function beijingDate(time: number): string {
  return new Date(time + BEIJING_OFFSET).toISOString().slice(0, 10);
}
function dayStart(date: string | undefined): number {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new UsageRangeError('usage_invalid_date');
  const value = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) {
    throw new UsageRangeError('usage_invalid_date');
  }
  return value - BEIJING_OFFSET;
}
/** Inclusive Beijing calendar dates at the UI, half-open UTC instants at storage. */
export function resolveUsageRange(input: UsageTimelineRequest, now: Date, subscription?: QuotaWindow): UsageRange {
  const period = input.period ?? '7days';
  if (!(USAGE_PERIODS as readonly string[]).includes(period)) throw new UsageRangeError('usage_invalid_period');
  if (input.groupBy !== undefined && input.groupBy !== 'model' && input.groupBy !== 'provider') {
    throw new UsageRangeError('usage_invalid_group');
  }
  if (period !== 'custom' && (input.start !== undefined || input.end !== undefined)) {
    throw new UsageRangeError('usage_unexpected_dates');
  }
  const today = dayStart(beijingDate(now.getTime()));
  const calendar = new Date(today + BEIJING_OFFSET);
  const monthStart = (delta: number) => Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth() + delta, 1) - BEIJING_OFFSET;
  let from = today;
  let to = today + DAY;
  switch (period) {
    case 'week': from -= ((calendar.getUTCDay() + 6) % 7) * DAY; break;
    case '7days': from -= 6 * DAY; break;
    case '30days': from -= 29 * DAY; break;
    case 'month': from = monthStart(0); break;
    case 'lastMonth': from = monthStart(-1); to = monthStart(0); break;
    case 'custom': from = dayStart(input.start); to = dayStart(input.end) + DAY; break;
    case 'subscription':
      if (!subscription || !isUsageTimestamp(subscription.start) || !isUsageTimestamp(subscription.end)) {
        throw new UsageRangeError('usage_subscription_unavailable');
      }
      from = Date.parse(subscription.start); to = Date.parse(subscription.end); break;
  }
  if (from >= to || to - from > 366 * DAY) throw new UsageRangeError('usage_range_limit');
  if (!isUsageTimestamp(new Date(from).toISOString()) || !isUsageTimestamp(new Date(to).toISOString())) throw new UsageRangeError('usage_invalid_date');
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), start: beijingDate(from), end: beijingDate(to - 1) };
}
export interface UsageBucket {
  totalTokens: string; includedTokens: string; onDemandTokens: string; unattributedTokens: string;
  calls: number; missingCalls: number; unattributedCalls: number;
}
export interface UsageSeries { id: string; label: string; tokens: string }
export interface UsageDay extends UsageBucket { date: string; values: Record<string, string> }
export interface TokenUsageTimeline {
  timezone: 'Asia/Shanghai'; groupBy: UsageGroup; range: UsageRange;
  totals: UsageBucket; series: UsageSeries[]; days: UsageDay[];
}
function emptyBucket(): UsageBucket {
  return { totalTokens: '0', includedTokens: '0', onDemandTokens: '0', unattributedTokens: '0', calls: 0, missingCalls: 0, unattributedCalls: 0 };
}
function add(bucket: UsageBucket, fact: ModelUsageFact, count: bigint): void {
  bucket.totalTokens = (BigInt(bucket.totalTokens) + count).toString();
  const field = fact.payer === 'platform' ? 'includedTokens' : fact.payer === 'user_direct' ? 'onDemandTokens' : 'unattributedTokens';
  bucket[field] = (BigInt(bucket[field]) + count).toString();
  bucket.calls++;
  if (fact.usageSource === 'provider_unavailable' || fact.inputTokens === null || fact.outputTokens === null) bucket.missingCalls++;
  if (field === 'unattributedTokens') bucket.unattributedCalls++;
}
/** Input/output are the canonical totals; cache and reasoning breakdowns are not added twice. */
export function projectTokenUsageTimeline(facts: Iterable<ModelUsageFact>, range: UsageRange, groupBy: UsageGroup): TokenUsageTimeline {
  const days = new Map<string, UsageDay>();
  for (let time = dayStart(range.start); time < Date.parse(range.to); time += DAY) {
    const date = beijingDate(time);
    days.set(date, { date, ...emptyBucket(), values: Object.create(null) as Record<string, string> });
  }
  const totals = emptyBucket();
  const series = new Map<string, UsageSeries>();
  for (const fact of facts) {
    if (fact.payer === 'system' || fact.occurredAtUtc < range.from || fact.occurredAtUtc >= range.to) continue;
    const day = days.get(beijingDate(Date.parse(fact.occurredAtUtc)));
    if (!day) continue;
    const raw = groupBy === 'model' ? fact.modelId : fact.providerRef;
    // JSON identity prevents a real "unknown" model or __proto__ from colliding with missing metadata.
    const id = JSON.stringify([raw]);
    const item = series.get(id) ?? { id, label: raw ?? (groupBy === 'model' ? '未记录模型' : '未记录 Provider'), tokens: '0' };
    const count = BigInt(fact.inputTokens ?? '0') + BigInt(fact.outputTokens ?? '0');
    item.tokens = (BigInt(item.tokens) + count).toString();
    series.set(id, item);
    day.values[id] = (BigInt(day.values[id] ?? '0') + count).toString();
    add(day, fact, count); add(totals, fact, count);
  }
  return { timezone: 'Asia/Shanghai', groupBy, range, totals, series: [...series.values()].sort((a, b) => a.id.localeCompare(b.id)), days: [...days.values()] };
}
