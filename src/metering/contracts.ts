/**
 * 计量领域契约（ADR-0042 §3、§4；实施计划 §4）。
 *
 * `stage` / `reason` / `resource` 三个维度正交，绝不互相相加。每条观测都
 * 携带稳定的 source event 键、覆盖层级、精确数量、质量与付款方，并且只
 * 有一个权威覆盖范围参与汇总。
 */

import type { Payer } from '../billing/cost-policy.js';
import type { BillingResource } from '../billing/pricing.js';
import { rational, type Rational } from '../billing/money.js';

export const METERING_STAGES = [
  'intake',
  'context',
  'planning',
  'execution',
  'verification',
  'delivery',
] as const;
export type MeteringStage = (typeof METERING_STAGES)[number];

export const METERING_REASONS = [
  'primary',
  'retry',
  'fallback',
  'replan',
  'compaction',
  'merge_repair',
  'system_probe',
] as const;
export type MeteringReason = (typeof METERING_REASONS)[number];

export const SOURCE_SCOPES = [
  'model_request',
  'harness_turn',
  'attempt',
  'resource_allocation',
] as const;
export type SourceScope = (typeof SOURCE_SCOPES)[number];

export const USAGE_QUALITIES = ['reported', 'estimated', 'unavailable'] as const;
export type UsageQuality = (typeof USAGE_QUALITIES)[number];

export function isMeteringStage(value: string): value is MeteringStage {
  return (METERING_STAGES as readonly string[]).includes(value);
}

export function isMeteringReason(value: string): value is MeteringReason {
  return (METERING_REASONS as readonly string[]).includes(value);
}

export function isSourceScope(value: string): value is SourceScope {
  return (SOURCE_SCOPES as readonly string[]).includes(value);
}

/** 跨进程传输的精确有理数：大整数只能以十进制字符串出现。 */
export interface ExactQuantity {
  readonly numerator: string;
  readonly denominator: string;
}

const DECIMAL_INTEGER = /^-?\d+$/u;

export function exactQuantityFromRational(value: Rational): ExactQuantity {
  return Object.freeze({
    numerator: value.numerator.toString(),
    denominator: value.denominator.toString(),
  });
}

export function rationalFromExactQuantity(value: ExactQuantity): Rational {
  if (!DECIMAL_INTEGER.test(value.numerator) || !DECIMAL_INTEGER.test(value.denominator)) {
    throw new Error('invalid_quantity');
  }
  return rational(BigInt(value.numerator), BigInt(value.denominator));
}

/**
 * 同一覆盖范围只能选一个权威计量层级：父级汇总与子级明细同时出现时，
 * 只有 `authoritativeScopes[sourceId]` 声明的层级参与汇总。
 */
export function isAuthoritativeScope(
  scope: SourceScope,
  authoritative: SourceScope | undefined,
): boolean {
  return authoritative === undefined || authoritative === scope;
}

export interface UsageObservation {
  readonly cumulativeValue?: string | null;
  readonly observationId: string;
  readonly sourceId: string;
  readonly sourceEventKey: string;
  readonly sourceScope: SourceScope;
  readonly callId: string;
  readonly queryId: string;
  readonly executionSegmentId: string | null;
  readonly taskId: string | null;
  readonly stage: MeteringStage | null;
  readonly reason: MeteringReason;
  readonly resource: BillingResource;
  readonly metric: string;
  readonly unit: string;
  readonly quantity: ExactQuantity;
  readonly quality: UsageQuality;
  /** 是否计入总量；父子重复或 cache/reasoning 子集为 false。 */
  readonly countsTowardTotal: boolean;
  readonly payer: Payer;
  readonly agentClassRef?: string | null;
  readonly providerRef?: string | null;
  readonly modelId?: string | null;
  readonly capturedAt: string;
  readonly providerBindingVersion: string | null;
  readonly evidenceRef: string | null;
  /** 规范化规则版本，用于解释历史观测为何如此拆分。 */
  readonly normalizationRuleVersion: string;
}

export function isZeroQuantity(observation: UsageObservation): boolean {
  return rationalFromExactQuantity(observation.quantity).numerator === 0n;
}

export function observationKey(observation: UsageObservation): string {
  return `${observation.sourceId}#${observation.sourceEventKey}#${observation.metric}`;
}
