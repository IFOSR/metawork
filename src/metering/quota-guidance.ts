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
  /** Same-origin asset used to identify the provider at a glance. */
  readonly logoUrl?: string;
}

/**
 * The maintained third-party provider directory shown next to usage guidance.
 * Entries are real services with their own account and billing; they are never
 * presented as MetaWork Included capacity.
 */
export const PROVIDER_DIRECTORY: readonly ProviderDirectoryEntry[] = [
  {
    id: 'metafusion-meta-router',
    name: 'Meta Router',
    description: '统一的 AI 模型聚合与分发网关，兼容 OpenAI / Claude / Gemini 接口，按你的账户独立计费。',
    models: ['OpenAI 兼容', 'Claude 兼容', 'Gemini 兼容'],
    capabilities: ['多模型聚合', '统一网关', '跨格式转换'],
    url: 'https://airouter.metafusion.cn/',
    offer: '第三方供应商，自行注册并管理额度',
    logoUrl: '/provider-metafusion.png',
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
  const providers = input.providers ?? PROVIDER_DIRECTORY;
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
