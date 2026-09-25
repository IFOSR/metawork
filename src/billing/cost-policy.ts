/**
 * 付款方与费用政策（ADR-0042 §5、§4.4）。
 *
 * 付款方只来自可信服务端配置或可核实凭据关系，绝不来自模型名、Provider
 * 显示名或客户端自报。`user_direct` 的模型费用不再向用户收取平台费用，
 * 但 MetaWork 自己提供的执行资源仍可按已发布规则单独计费。
 */

import type { BillingResource } from './pricing.js';

export const PAYERS = ['platform', 'user_direct', 'system', 'unknown'] as const;
export type Payer = (typeof PAYERS)[number];

export function isPayer(value: string): value is Payer {
  return (PAYERS as readonly string[]).includes(value);
}

export const COST_DISPOSITIONS = ['eligible', 'absorbed', 'pending'] as const;
export type CostDisposition = (typeof COST_DISPOSITIONS)[number];

/** MetaWork 自有的执行资源：即使用户自付模型费用，仍可单独计费。 */
const METAWORK_EXECUTION_RESOURCES: ReadonlySet<BillingResource> = new Set([
  'compute',
  'storage',
  'network',
  'tool_request',
]);

export interface CostClassificationInput {
  readonly payer: Payer;
  readonly resource: BillingResource;
  /** 是否已配置权威价格；未配置时只能待核对。 */
  readonly hasPrice: boolean;
  /** 数量来自估算而非可信计量；估算默认不作为收费依据。 */
  readonly quantityIsEstimate?: boolean;
  /** 调用确实发生但用量丢失；不是零，也不能凭猜测收费。 */
  readonly usageUnavailable?: boolean;
  /** 平台缺陷、内部返工等由平台自担的成本。 */
  readonly platformBorneDefect?: boolean;
  /** 用户自付模型时，该观测是否由 MetaWork 直接提供并运营。 */
  readonly metaWorkProvidedResource?: boolean;
}

export interface CostClassification {
  readonly disposition: CostDisposition;
  /** 只有 eligible 进入 `BillableBase`。 */
  readonly billableBase: boolean;
  readonly reason: string;
}

/**
 * 分类一条成本记录。顺序即政策优先级：价格与数量可信度先于付款方，
 * 平台自担优先于平台付款方，未知付款方只保留用量、待人工核实。
 */
export function classifyCostEntry(input: CostClassificationInput): CostClassification {
  if (!isPayer(input.payer)) throw new Error('invalid_payer');
  if (input.usageUnavailable) {
    return { disposition: 'pending', billableBase: false, reason: 'usage_unavailable' };
  }
  if (!input.hasPrice) {
    return { disposition: 'pending', billableBase: false, reason: 'price_unavailable' };
  }
  if (input.quantityIsEstimate) {
    return { disposition: 'pending', billableBase: false, reason: 'estimated_quantity' };
  }
  switch (input.payer) {
    case 'user_direct':
      return input.metaWorkProvidedResource && METAWORK_EXECUTION_RESOURCES.has(input.resource)
        ? { disposition: 'eligible', billableBase: true, reason: 'user_direct_model_metawork_resource' }
        : { disposition: 'absorbed', billableBase: false, reason: 'user_direct_payer' };
    case 'system':
      return { disposition: 'absorbed', billableBase: false, reason: 'system_cost' };
    case 'unknown':
      return { disposition: 'pending', billableBase: false, reason: 'payer_unknown' };
    case 'platform':
      return input.platformBorneDefect
        ? { disposition: 'absorbed', billableBase: false, reason: 'platform_defect_absorbed' }
        : { disposition: 'eligible', billableBase: true, reason: 'platform_payer' };
    default: {
      const exhaustive: never = input.payer;
      throw new Error(`invalid_payer:${String(exhaustive)}`);
    }
  }
}

/**
 * 平台承担缺失项需要审计记录（ADR-0042 §7）。返回的记录必须随最终单保存，
 * 并保留 `coverage=incomplete` 与缺失原因，不能把未知成本填成零。
 */
export interface PlatformAbsorptionDecision {
  readonly reason: string;
  readonly authorizedBy: string;
  readonly decidedAt: string;
  readonly missingCategories: readonly string[];
}

export function validatePlatformAbsorption(
  decision: PlatformAbsorptionDecision,
): PlatformAbsorptionDecision {
  if (decision.reason.trim().length === 0) throw new Error('invalid_absorption_reason');
  if (decision.authorizedBy.trim().length === 0) throw new Error('invalid_absorption_authorizer');
  if (decision.decidedAt.trim().length === 0) throw new Error('invalid_absorption_time');
  if (decision.missingCategories.length === 0) throw new Error('invalid_absorption_categories');
  return Object.freeze({
    reason: decision.reason,
    authorizedBy: decision.authorizedBy,
    decidedAt: decision.decidedAt,
    missingCategories: Object.freeze([...decision.missingCategories]),
  });
}
