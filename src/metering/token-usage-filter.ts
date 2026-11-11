import type { ModelUsageFilter } from './ports.js';

/** UTC millisecond timestamps keep the persisted range comparisons exact. */
export function isUsageTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function validateModelUsageFilter(input: ModelUsageFilter): void {
  if (!input.accountId?.trim()) throw new Error('usage_account_required');
  if ((input.from !== undefined && !isUsageTimestamp(input.from))
    || (input.to !== undefined && !isUsageTimestamp(input.to))
    || (input.from !== undefined && input.to !== undefined && input.from >= input.to)) {
    throw new Error('usage_invalid_time_range');
  }
}
