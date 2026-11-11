import { quotaForPlan, quotaWindowFor, type PlanQuotaDefinition } from './plan-quota.js';
import type { TokenUsageTotals } from './token-usage-service.js';

/** A replaceable provider directory entry used by quota guidance surfaces. */
export interface ProviderDirectoryEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly models: readonly string[];
  readonly capabilities: readonly string[];
  readonly url: string;
  readonly offer: string;
}

/**
 * Product placeholder data. Keep this contract stable and replace these rows
 * with the maintained provider catalog when commercial partnerships are ready.
 */
export const VIRTUAL_PROVIDER_DIRECTORY: readonly ProviderDirectoryEntry[] = [
  {
    id: 'virtual-orbit-models',
    name: 'Orbit Models（示例）',
    description: '通用文本与代码模型，支持按量注册外部账户。',
    models: ['Orbit Pro', 'Orbit Code'],
    capabilities: ['文本生成', '代码执行规划', '长上下文'],
    url: 'https://providers.example.invalid/orbit-models',
    offer: '示例入口，后续替换为正式供应商链接',
  },
  {
    id: 'virtual-lantern-ai',
    name: 'Lantern AI（示例）',
    description: '面向研究与文档任务的第三方模型服务。',
    models: ['Lantern Research', 'Lantern Writer'],
    capabilities: ['资料整理', '文档生成', '多语言'],
    url: 'https://providers.example.invalid/lantern-ai',
    offer: '示例入口，后续替换为正式供应商链接',
  },
];

export type QuotaGuidanceStatus = 'available' | 'exhausted' | 'usage_unavailable' | 'unknown_plan';

export interface QuotaGuidance {
  readonly status: QuotaGuidanceStatus;
  readonly planId: string;
  readonly usedTokens: string;
  readonly limit: number;
  readonly remainingTokens: string;
  readonly message: string;
  readonly providers: readonly ProviderDirectoryEntry[];
}

export function quotaGuidanceFor(input: {
  readonly catalog: readonly PlanQuotaDefinition[];
  readonly planId: string;
  readonly now: Date;
  readonly trialStartedAt?: Date;
  readonly usage: TokenUsageTotals;
  readonly providers?: readonly ProviderDirectoryEntry[];
}): QuotaGuidance {
  const definition = quotaForPlan(input.catalog, input.planId);
  const providers = input.providers ?? VIRTUAL_PROVIDER_DIRECTORY;
  if (!definition) {
    return {
      status: 'unknown_plan', planId: input.planId, usedTokens: '0', limit: 0,
      remainingTokens: '0',
      message: '当前托管套餐无法识别，可使用下方第三方供应商继续任务。', providers,
    };
  }
  // Keep the query and the preflight check on the same Beijing/UTC window.
  quotaWindowFor(definition, { now: input.now, ...(input.trialStartedAt ? { trialStartedAt: input.trialStartedAt } : {}) });
  const usedTokens = BigInt(input.usage.inputTokens) + BigInt(input.usage.outputTokens);
  const safeUsedTokens = usedTokens <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(usedTokens) : Number.MAX_SAFE_INTEGER;
  if (input.usage.missingCalls > 0) {
    return {
      status: 'usage_unavailable', planId: input.planId,
      usedTokens: usedTokens.toString(), limit: definition.includedTokens,
      remainingTokens: '0',
      message: '托管用量正在收束，任务不会被阻断；也可以选择下方第三方供应商。', providers,
    };
  }
  const remaining = Math.max(0, definition.includedTokens - safeUsedTokens);
  if (safeUsedTokens >= definition.includedTokens) {
    return {
      status: 'exhausted', planId: input.planId,
      usedTokens: usedTokens.toString(), limit: definition.includedTokens,
      remainingTokens: '0',
      message: `本周期 Included 额度已用尽（${usedTokens.toString()}/${definition.includedTokens} Token），任务不会被阻断，可选择下方第三方供应商继续。`,
      providers,
    };
  }
  return {
    status: 'available', planId: input.planId,
    usedTokens: usedTokens.toString(), limit: definition.includedTokens,
    remainingTokens: remaining.toString(),
    message: `本周期 Included 额度还剩 ${remaining.toString()} Token。`, providers,
  };
}
