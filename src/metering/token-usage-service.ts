import { projectTokenUsageTimeline, type UsageRange, type UsageGroup, type TokenUsageTimeline } from './token-usage-timeline.js';
import type { MeteringStore, ModelUsageFact, ModelUsageFilter } from './ports.js';
import { validateModelUsageFilter } from './token-usage-filter.js';

export interface TokenUsageTotals {
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly cacheReadTokens: string;
  readonly cacheWriteTokens: string;
  readonly reasoningTokens: string;
  readonly calls: number;
  readonly missingCalls: number;
}

/** User-facing token projection. It never accepts or returns a price field. */
export class TokenUsageService {
  constructor(private readonly store: Required<Pick<MeteringStore, 'listModelUsageFacts'>>
    & Pick<MeteringStore, 'iterateModelUsageFacts'>) {}

  list(input: ModelUsageFilter): ModelUsageFact[] {
    validateModelUsageFilter(input);
    return this.store.listModelUsageFacts(input);
  }

  timeline(input: ModelUsageFilter, range: UsageRange, groupBy: UsageGroup): TokenUsageTimeline {
    return projectTokenUsageTimeline(this.iterate({ ...input, from: range.from, to: range.to }), range, groupBy);
  }

  private iterate(input: ModelUsageFilter): Iterable<ModelUsageFact> {
    validateModelUsageFilter(input);
    return this.store.iterateModelUsageFacts?.(input) ?? this.store.listModelUsageFacts(input);
  }

  aggregate(input: ModelUsageFilter): TokenUsageTotals {
    const sums = { inputTokens: 0n, outputTokens: 0n, cacheReadTokens: 0n, cacheWriteTokens: 0n, reasoningTokens: 0n };
    let calls = 0;
    let missingCalls = 0;
    for (const fact of this.iterate(input)) {
      for (const field of Object.keys(sums) as Array<keyof typeof sums>) sums[field] += BigInt(fact[field] ?? '0');
      calls += 1;
      if (fact.usageSource === 'provider_unavailable' || fact.inputTokens === null || fact.outputTokens === null) missingCalls += 1;
    }
    return {
      inputTokens: sums.inputTokens.toString(), outputTokens: sums.outputTokens.toString(),
      cacheReadTokens: sums.cacheReadTokens.toString(), cacheWriteTokens: sums.cacheWriteTokens.toString(),
      reasoningTokens: sums.reasoningTokens.toString(), calls, missingCalls,
    };
  }
}
