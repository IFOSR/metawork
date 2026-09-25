/**
 * 用量规范化（ADR-0042 §3、§4；实施计划 §4.3）。
 *
 * - delta 与 cumulative snapshot 分离；累计值按同一 `(sourceId, callId,
 *   metric)` 的有序快照求差，计数器重置不静默计入。
 * - 同一次调用的事件重放不重复计量；真正的 retry/fallback 是新 callId。
 * - cache/reasoning 等子集保留原始计数，但不与父指标重复计入总量。
 * - 缺少 usage 是 `unavailable`，不是 0。
 */

import { isBillingResource, rationalFromDecimalString } from '../billing/pricing.js';
import { isNegativeRational, isZeroRational, subtractRational, type Rational } from '../billing/money.js';
import {
  exactQuantityFromRational,
  isAuthoritativeScope,
  type MeteringReason,
  type MeteringStage,
  type SourceScope,
  type UsageObservation,
  type UsageQuality,
} from './contracts.js';
import type { Payer } from '../billing/cost-policy.js';

export const NORMALIZATION_RULE_VERSION = 'usage-normalizer-v1';

export interface RawUsageCounter {
  readonly resource: string;
  readonly metric: string;
  readonly unit: string;
  readonly kind: 'delta' | 'cumulative';
  /** 十进制字符串；不接受浮点 number。 */
  readonly value: string;
  /** 本指标是另一个指标的组成子集时声明父指标名，避免重复收费。 */
  readonly subsetOf?: string;
  /** 质量不可信或来源为估算时的显式标记。 */
  readonly quality?: UsageQuality;
}

export interface RawMissingMetric {
  readonly resource: string;
  readonly metric: string;
  readonly unit: string;
}

export interface RawUsageEvent {
  readonly sourceId: string;
  readonly sourceEventKey: string;
  readonly sourceScope: SourceScope;
  readonly callId: string;
  readonly queryId: string;
  readonly executionSegmentId?: string | null;
  readonly taskId?: string | null;
  readonly stage?: MeteringStage | null;
  readonly reason?: MeteringReason;
  readonly payer?: Payer;
  readonly agentClassRef?: string | null;
  readonly providerRef?: string | null;
  readonly modelId?: string | null;
  readonly capturedAt: string;
  readonly providerBindingVersion?: string | null;
  readonly evidenceRef?: string | null;
  readonly counters: readonly RawUsageCounter[];
  /** 调用确实发生但最终 usage 丢失时显式声明的缺失指标。 */
  readonly missing?: readonly RawMissingMetric[];
}

export interface CumulativeSnapshot {
  readonly sourceId: string;
  readonly callId: string;
  readonly metric: string;
  readonly value: string;
}

export type NormalizationIssueCode =
  | 'duplicate_event'
  | 'counter_reset'
  | 'unsupported_resource'
  | 'invalid_quantity'
  | 'missing_usage';

export interface NormalizationIssue {
  readonly code: NormalizationIssueCode;
  readonly sourceId: string;
  readonly sourceEventKey: string;
  readonly detail: string;
}

export interface NormalizationInput {
  readonly events: readonly RawUsageEvent[];
  readonly previousSnapshots?: readonly CumulativeSnapshot[];
  /** 同一 source 的权威计量层级；未声明时不做父子去重过滤。 */
  readonly authoritativeScopes?: Readonly<Record<string, SourceScope>>;
  /** 已经处理过的 source event 键（重放保护）。 */
  readonly knownSourceEventKeys?: readonly string[];
  readonly ruleVersion?: string;
  readonly createObservationId?: (event: RawUsageEvent, metric: string) => string;
}

export interface NormalizationResult {
  readonly observations: UsageObservation[];
  readonly snapshots: CumulativeSnapshot[];
  readonly issues: NormalizationIssue[];
}

function snapshotKey(sourceId: string, callId: string, metric: string): string {
  return `${sourceId}\u0000${callId}\u0000${metric}`;
}

/** 规范化一批来源事件；输出顺序稳定，便于幂等重放与测试。 */
export function normalizeUsageEvents(input: NormalizationInput): NormalizationResult {
  const ruleVersion = input.ruleVersion ?? NORMALIZATION_RULE_VERSION;
  const createObservationId = input.createObservationId
    ?? ((event, metric) => `${event.sourceId}:${event.sourceEventKey}:${metric}`);
  const seen = new Set(input.knownSourceEventKeys ?? []);
  const snapshots = new Map<string, CumulativeSnapshot>();
  for (const snapshot of input.previousSnapshots ?? []) {
    snapshots.set(snapshotKey(snapshot.sourceId, snapshot.callId, snapshot.metric), snapshot);
  }
  const observations: UsageObservation[] = [];
  const issues: NormalizationIssue[] = [];

  for (const event of input.events) {
    const replayKey = `${event.sourceId}#${event.sourceEventKey}`;
    if (seen.has(replayKey)) {
      issues.push({
        code: 'duplicate_event',
        sourceId: event.sourceId,
        sourceEventKey: event.sourceEventKey,
        detail: 'source event already metered',
      });
      continue;
    }
    seen.add(replayKey);
    const quality: UsageQuality = event.counters.length > 0 ? 'reported' : 'unavailable';
    for (const counter of event.counters) {
      if (!isBillingResource(counter.resource)) {
        issues.push({
          code: 'unsupported_resource',
          sourceId: event.sourceId,
          sourceEventKey: event.sourceEventKey,
          detail: `${counter.resource}:${counter.metric} is not a metered resource`,
        });
        continue;
      }
      let quantity: Rational;
      try {
        quantity = rationalFromDecimalString(counter.value);
      } catch {
        issues.push({
          code: 'invalid_quantity',
          sourceId: event.sourceId,
          sourceEventKey: event.sourceEventKey,
          detail: `${counter.resource}:${counter.metric}=${counter.value}`,
        });
        continue;
      }
      if (isNegativeRational(quantity)) {
        issues.push({
          code: 'invalid_quantity',
          sourceId: event.sourceId,
          sourceEventKey: event.sourceEventKey,
          detail: `negative ${counter.resource}:${counter.metric}`,
        });
        continue;
      }
      const authoritative = isAuthoritativeScope(
        event.sourceScope,
        input.authoritativeScopes?.[event.sourceId],
      );
      const key = snapshotKey(event.sourceId, event.callId, counter.metric);
      if (counter.kind === 'cumulative') {
        const previous = snapshots.get(key);
        const current: CumulativeSnapshot = {
          sourceId: event.sourceId,
          callId: event.callId,
          metric: counter.metric,
          value: counter.value,
        };
        if (previous) {
          const before = rationalFromDecimalString(previous.value);
          const diff = subtractRational(quantity, before);
          if (isNegativeRational(diff)) {
            // 计数器重置必须使用新的 scope；不把重置值当作增量。
            issues.push({
              code: 'counter_reset',
              sourceId: event.sourceId,
              sourceEventKey: event.sourceEventKey,
              detail: `${counter.metric} dropped from ${previous.value} to ${counter.value}; new call scope required`,
            });
            continue;
          }
          snapshots.set(key, current);
          if (!isZeroRational(diff)) {
            observations.push(buildObservation(event, counter, diff, authoritative, ruleVersion, createObservationId));
          }
          continue;
        }
        snapshots.set(key, current);
        observations.push(buildObservation(event, counter, quantity, authoritative, ruleVersion, createObservationId));
        continue;
      }
      observations.push(buildObservation(event, counter, quantity, authoritative, ruleVersion, createObservationId));
    }
    for (const missing of event.missing ?? []) {
      if (!isBillingResource(missing.resource)) continue;
      issues.push({
        code: 'missing_usage',
        sourceId: event.sourceId,
        sourceEventKey: event.sourceEventKey,
        detail: `${missing.resource}:${missing.metric} unavailable for ${event.callId}`,
      });
      observations.push(Object.freeze({
        observationId: createObservationId(event, missing.metric),
        sourceId: event.sourceId,
        sourceEventKey: event.sourceEventKey,
        sourceScope: event.sourceScope,
        callId: event.callId,
        queryId: event.queryId,
        executionSegmentId: event.executionSegmentId ?? null,
        taskId: event.taskId ?? null,
        stage: event.stage ?? null,
        reason: event.reason ?? 'primary',
        resource: missing.resource,
        metric: missing.metric,
        unit: missing.unit,
        quantity: exactQuantityFromRational(rationalFromDecimalString('0')),
        quality: 'unavailable',
        countsTowardTotal: false,
        payer: event.payer ?? 'unknown',
        agentClassRef: event.agentClassRef ?? null,
        providerRef: event.providerRef ?? null,
        modelId: event.modelId ?? null,
        capturedAt: event.capturedAt,
        providerBindingVersion: event.providerBindingVersion ?? null,
        evidenceRef: event.evidenceRef ?? null,
        normalizationRuleVersion: ruleVersion,
      }));
    }
  }
  return {
    observations,
    snapshots: [...snapshots.values()].sort((left, right) => (
      snapshotKey(left.sourceId, left.callId, left.metric)
        .localeCompare(snapshotKey(right.sourceId, right.callId, right.metric))
    )),
    issues,
  };
}

function buildObservation(
  event: RawUsageEvent,
  counter: RawUsageCounter,
  quantity: Rational,
  authoritative: boolean,
  ruleVersion: string,
  createObservationId: (event: RawUsageEvent, metric: string) => string,
): UsageObservation {
  const isSubset = typeof counter.subsetOf === 'string' && counter.subsetOf.length > 0;
  return Object.freeze({
    cumulativeValue: counter.kind === 'cumulative' ? counter.value : null,
    observationId: createObservationId(event, counter.metric),
    sourceId: event.sourceId,
    sourceEventKey: event.sourceEventKey,
    sourceScope: event.sourceScope,
    callId: event.callId,
    queryId: event.queryId,
    executionSegmentId: event.executionSegmentId ?? null,
    taskId: event.taskId ?? null,
    stage: event.stage ?? null,
    reason: event.reason ?? 'primary',
    resource: counter.resource as UsageObservation['resource'],
    metric: counter.metric,
    unit: counter.unit,
    quantity: exactQuantityFromRational(quantity),
    quality: counter.quality ?? 'reported',
    countsTowardTotal: authoritative && !isSubset,
    payer: event.payer ?? 'unknown',
    agentClassRef: event.agentClassRef ?? null,
    providerRef: event.providerRef ?? null,
    modelId: event.modelId ?? null,
    capturedAt: event.capturedAt,
    providerBindingVersion: event.providerBindingVersion ?? null,
    evidenceRef: event.evidenceRef ?? null,
    normalizationRuleVersion: ruleVersion,
  });
}
