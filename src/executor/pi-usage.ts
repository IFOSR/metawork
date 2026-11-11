import type { HarnessUsageCounter, HarnessUsageEvent } from './harness-driver.js';

/** Pi input excludes cache reads/writes; MetaWork input includes both subsets. */
export function normalizePiUsage(usage: {
  readonly input?: unknown;
  readonly output?: unknown;
  readonly cacheRead?: unknown;
  readonly cacheWrite?: unknown;
  readonly reasoning?: unknown;
}): Pick<HarnessUsageEvent, 'counters' | 'missing'> {
  const rawInput = integerString(usage.input);
  const cacheRead = integerString(usage.cacheRead);
  const cacheWrite = integerString(usage.cacheWrite);
  const input = rawInput !== null
    && (usage.cacheRead === undefined || cacheRead !== null)
    && (usage.cacheWrite === undefined || cacheWrite !== null)
    ? (BigInt(rawInput) + BigInt(cacheRead ?? '0') + BigInt(cacheWrite ?? '0')).toString()
    : null;
  const output = integerString(usage.output);
  const counters: HarnessUsageCounter[] = [];
  for (const [metric, value, subsetOf] of [
    ['input', input, undefined], ['output', output, undefined],
    ['cache_read', cacheRead, 'input'], ['cache_write', cacheWrite, 'input'],
    ['reasoning', integerString(usage.reasoning), 'output'],
  ] as const) {
    if (value !== null) counters.push({
      resource: 'model_tokens', metric, unit: 'token', kind: 'delta', value,
      ...(subsetOf ? { subsetOf } : {}),
    });
  }
  const missing = [
    ...(input === null ? [{ resource: 'model_tokens' as const, metric: 'input', unit: 'token' as const }] : []),
    ...(output === null ? [{ resource: 'model_tokens' as const, metric: 'output', unit: 'token' as const }] : []),
  ];
  return { counters, ...(missing.length ? { missing } : {}) };
}

function integerString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/u.test(value)) return value;
  return null;
}
