/**
 * 不可变价格版本与精确成本核算（ADR-0042 §5、§6）。
 *
 * 价格按“资源 / 计量指标”给出每单位精确单价（nanoCny）。数量与单价均为
 * 精确有理数，相乘后仍是精确有理数；只在 Query 汇总处舍入一次。
 * 汇率如启用必须固定来源、币种与生效版本，不用运行时行情重算历史。
 */

import {
  addRational,
  isNegativeRational,
  isZeroRational,
  MAX_MARKUP_BPS,
  MIN_MARKUP_BPS,
  multiplyRational,
  rational,
  ZERO_RATIONAL,
  type Rational,
} from './money.js';

export const BILLING_RESOURCES = [
  'model_tokens',
  'image',
  'search',
  'tool_request',
  'compute',
  'storage',
  'network',
] as const;

export type BillingResource = (typeof BILLING_RESOURCES)[number];

export function isBillingResource(value: string): value is BillingResource {
  return (BILLING_RESOURCES as readonly string[]).includes(value);
}

export function priceKey(resource: BillingResource, metric: string): string {
  if (metric.trim().length === 0) throw new Error('invalid_metric');
  return `${resource}:${metric}`;
}

function scopedPriceKey(input: Pick<PriceUnitInput, 'resource' | 'metric' | 'agentClassRef' | 'providerRef' | 'modelId'>): string {
  const scope = [
    input.agentClassRef ? `agent=${encodeURIComponent(input.agentClassRef)}` : null,
    input.providerRef ? `provider=${encodeURIComponent(input.providerRef)}` : null,
    input.modelId ? `model=${encodeURIComponent(input.modelId)}` : null,
  ].filter((part): part is string => part !== null);
  return `${priceKey(input.resource, input.metric)}${scope.length > 0 ? `|${scope.join('|')}` : ''}`;
}

export interface PriceUnitInput {
  readonly resource: BillingResource;
  readonly metric: string;
  readonly agentClassRef?: string;
  readonly providerRef?: string;
  readonly modelId?: string;
  /**
   * 单价币种。缺省为价格版本币种（CNY），此时单价直接以 nanoCny 表示；
   * 声明其他币种时按价格版本固定的汇率换算为 nanoCny。
   */
  readonly sourceCurrency?: string;
  /** 每单位资源的精确单价（nanoCny，或 `sourceCurrency` 的货币单位）。 */
  readonly nanoCnyPerUnit: Rational;
}

export interface PriceUnit {
  readonly resource: BillingResource;
  readonly metric: string;
  readonly agentClassRef?: string;
  readonly providerRef?: string;
  readonly modelId?: string;
  readonly sourceCurrency: string | null;
  readonly nanoCnyPerUnit: Rational;
}

export interface PriceBookVersionInput {
  readonly priceBookVersion: string;
  readonly feePolicyVersion: string;
  readonly markupBps: bigint;
  readonly effectiveFrom: string;
  readonly currency?: 'CNY';
  /** 可选固定汇率：1 单位源币种 = rate 元人民币。 */
  readonly exchangeRate?: {
    readonly sourceCurrency: string;
    readonly nanoCnyPerSourceUnit: Rational;
    readonly effectiveFrom: string;
  };
  readonly units: readonly PriceUnitInput[];
}

export interface PriceBookVersion {
  readonly priceBookVersion: string;
  readonly feePolicyVersion: string;
  readonly markupBps: bigint;
  readonly effectiveFrom: string;
  readonly currency: 'CNY';
  readonly exchangeRate: PriceBookVersionInput['exchangeRate'] | null;
  readonly units: ReadonlyMap<string, PriceUnit>;
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`invalid_${label}`);
  }
  return value;
}

/** 创建不可变价格版本；越界加价、负单价与重复键直接拒绝。 */
export function createPriceBookVersion(input: PriceBookVersionInput): PriceBookVersion {
  requireNonEmpty(input.priceBookVersion, 'price_book_version');
  requireNonEmpty(input.feePolicyVersion, 'fee_policy_version');
  requireNonEmpty(input.effectiveFrom, 'effective_from');
  if (input.markupBps < MIN_MARKUP_BPS || input.markupBps > MAX_MARKUP_BPS) {
    throw new Error('invalid_markup');
  }
  const units = new Map<string, PriceUnit>();
  for (const unit of input.units) {
    if (!isBillingResource(unit.resource)) throw new Error('invalid_resource');
    const key = scopedPriceKey(unit);
    if (units.has(key)) throw new Error(`duplicate_price_unit:${key}`);
    if (isNegativeRational(unit.nanoCnyPerUnit)) throw new Error(`negative_unit_price:${key}`);
    const sourceCurrency = unit.sourceCurrency ?? null;
    if (sourceCurrency && sourceCurrency !== (input.currency ?? 'CNY')) {
      const rate = input.exchangeRate;
      if (!rate || rate.sourceCurrency !== sourceCurrency) {
        throw new Error(`missing_exchange_rate:${sourceCurrency}`);
      }
    }
    units.set(key, Object.freeze({
      resource: unit.resource,
      metric: unit.metric,
      ...(unit.agentClassRef ? { agentClassRef: unit.agentClassRef } : {}),
      ...(unit.providerRef ? { providerRef: unit.providerRef } : {}),
      ...(unit.modelId ? { modelId: unit.modelId } : {}),
      sourceCurrency,
      nanoCnyPerUnit: unit.nanoCnyPerUnit,
    }));
  }
  return Object.freeze({
    priceBookVersion: input.priceBookVersion,
    feePolicyVersion: input.feePolicyVersion,
    markupBps: input.markupBps,
    effectiveFrom: input.effectiveFrom,
    currency: input.currency ?? 'CNY',
    exchangeRate: input.exchangeRate ? Object.freeze({ ...input.exchangeRate }) : null,
    units,
  });
}

export interface PricedUsage {
  readonly resource: BillingResource;
  readonly metric: string;
  readonly quantity: Rational;
  /** 非 CNY 计价时使用的源币种；缺省为 CNY。 */
  readonly sourceCurrency?: string;
  readonly agentClassRef?: string | null;
  readonly providerRef?: string | null;
  readonly modelId?: string | null;
}

export interface PricedCost {
  readonly priceKey: string;
  readonly unitPriceNanoCny: Rational;
  readonly costNanoCny: Rational;
}

/**
 * 计算一次观测的参考成本。未配置价格返回 null；调用方必须将其视为
 * `pending_reconciliation`，不得填成零（ADR-0042 §4）。
 */
export function costForUsage(
  book: PriceBookVersion,
  usage: PricedUsage,
): PricedCost | null {
  const unit = findPriceUnit(book, usage);
  if (!unit) return null;
  if (isNegativeRational(usage.quantity)) {
    throw new Error(`negative_quantity:${priceKey(usage.resource, usage.metric)}`);
  }
  let value = multiplyRational(unit.nanoCnyPerUnit, usage.quantity);
  if (unit.sourceCurrency) {
    if (usage.sourceCurrency !== unit.sourceCurrency) {
      throw new Error(`currency_mismatch:${unit.sourceCurrency}`);
    }
    const rate = book.exchangeRate;
    if (!rate || rate.sourceCurrency !== unit.sourceCurrency) {
      throw new Error(`missing_exchange_rate:${unit.sourceCurrency}`);
    }
    value = multiplyRational(value, rate.nanoCnyPerSourceUnit);
  } else if (usage.sourceCurrency && usage.sourceCurrency !== book.currency) {
    throw new Error(`missing_exchange_rate:${usage.sourceCurrency}`);
  }
  return {
    priceKey: scopedPriceKey({
      resource: usage.resource,
      metric: usage.metric,
      agentClassRef: usage.agentClassRef ?? undefined,
      providerRef: usage.providerRef ?? undefined,
      modelId: usage.modelId ?? undefined,
    }),
    unitPriceNanoCny: unit.nanoCnyPerUnit,
    costNanoCny: value,
  };
}

export function findPriceUnit(
  book: PriceBookVersion,
  usage: Pick<PricedUsage, 'resource' | 'metric' | 'agentClassRef' | 'providerRef' | 'modelId'>,
): PriceUnit | null {
  const candidates = [
    {
      agentClassRef: usage.agentClassRef ?? undefined,
      providerRef: usage.providerRef ?? undefined,
      modelId: usage.modelId ?? undefined,
    },
    {
      providerRef: usage.providerRef ?? undefined,
      modelId: usage.modelId ?? undefined,
    },
    { modelId: usage.modelId ?? undefined },
    {},
  ];
  for (const candidate of candidates) {
    const unit = book.units.get(scopedPriceKey({
      resource: usage.resource,
      metric: usage.metric,
      ...candidate,
    }));
    if (unit) return unit;
  }
  return null;
}

/** 汇总可收费成本基数（nanoCny 精确有理数）。 */
export function sumCostNanoCny(costs: readonly Rational[]): Rational {
  return costs.reduce((sum, cost) => addRational(sum, cost), ZERO_RATIONAL);
}

export function isZeroCost(cost: Rational): boolean {
  return isZeroRational(cost);
}

/**
 * 解析十进制字符串，或内部规范化的 `分子/分母` 形式（累计快照与精确有理数
 * 传输）。两者都不会经过浮点 number。
 */
export function rationalFromDecimalString(text: string, decimals = 0): Rational {
  const trimmed = text.trim();
  const rationalMatch = /^(-?\d+)\/(\d+)$/u.exec(trimmed);
  if (rationalMatch) return rational(BigInt(rationalMatch[1]!), BigInt(rationalMatch[2]!));
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(trimmed);
  if (!match) throw new Error('invalid_decimal_amount');
  const [, sign, whole, fraction = ''] = match;
  if (decimals > 0 && fraction.length > decimals) throw new Error('amount_precision_exceeded');
  const scale = 10n ** BigInt(fraction.length);
  const magnitude = BigInt(`${whole}${fraction}`);
  return rational(sign === '-' ? -magnitude : magnitude, scale);
}
