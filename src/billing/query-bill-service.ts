/**
 * Query 最终账单服务（ADR-0042 §5、§7；实施计划 §5.1/§5.3）。
 *
 * - 最终单不可变，且只在归因已定、没有活跃/不确定调用、费用与价格版本齐备
 *   时终结；Turn 完成或 Task 终态都不是终结条件。
 * - 平台缺陷、系统后台成本和用户自付模型成本不进入收费基数；未知付款方与
 *   未配置价格进入待核对。
 * - 阶段金额由最终总额确定性分配，明细之和等于总额。
 */

import {
  addRational,
  assessRationalMicroCoin,
  distributeByWeights,
  isZeroRational,
  rational,
  type Rational,
} from './money.js';
import { classifyCostEntry, type PlatformAbsorptionDecision } from './cost-policy.js';
import { costForUsage, findPriceUnit, type PriceBookVersion } from './pricing.js';
import type {
  BillStorePort,
  BillingUnitOfWork,
  ConsumptionOutboxPort,
  CostEntryPort,
  CostEntryRecord,
  PriceStorePort,
  QueryBillLineRecord,
  QueryBillRecord,
} from './ports.js';
import { projectCoverage, type CoverageReport } from '../metering/coverage-projector.js';
import type {
  MeteringStore,
  MeteringSpanRecord,
  PersistedUsageObservation,
  QueryContextStore,
} from '../metering/ports.js';
import { persistedObservationQuantity } from '../metering/ports.js';
import { buildConsumptionBill, canonicalConsumptionPayload } from './consumption-contract.js';

export interface QueryBillServiceDeps {
  readonly queryContexts: QueryContextStore;
  readonly metering: MeteringStore;
  readonly prices: PriceStorePort;
  readonly costEntries: CostEntryPort;
  readonly bills: BillStorePort;
  readonly unitOfWork: BillingUnitOfWork;
  /** 影子模式（shadow）不写 outbox，只生成本地账单。 */
  readonly consumption?: ConsumptionOutboxPort;
  readonly exportEnabled: () => boolean;
  /** 可信服务端配置的外部账户绑定；缺失时不允许 export。 */
  readonly resolveExternalAccountRef?: (accountId: string) => string | null;
  readonly createCostEntryId: (observationId: string, costKind: string) => string;
}

export interface FinalizeQueryBillInput {
  readonly queryId: string;
  readonly finalizedAt: string;
  /** 缺失项经审计由平台承担后才允许出单；保留 incomplete 覆盖率。 */
  readonly platformAbsorption?: PlatformAbsorptionDecision | null;
}

export type FinalizeQueryBillResult =
  | { readonly status: 'finalized'; readonly bill: QueryBillRecord }
  | { readonly status: 'already_finalized'; readonly bill: QueryBillRecord }
  | {
      readonly status: 'pending_reconciliation';
      readonly bill: QueryBillRecord;
      readonly reasons: readonly string[];
      readonly coverage: CoverageReport;
    };

interface CollectedCost {
  readonly observation: PersistedUsageObservation;
  readonly entry: CostEntryRecord;
  readonly costNanoCny: Rational;
  readonly disposition: CostEntryRecord['disposition'];
  readonly reason: string;
}

export interface QueryBillService {
  finalizeQueryBill(input: FinalizeQueryBillInput): FinalizeQueryBillResult;
  /** 进行中的暂计，不是最终单：用于三端展示与影子统计。 */
  previewQueryUsage(queryId: string): {
    readonly assessedMicroCoin: string;
    readonly coverage: CoverageReport;
    readonly pendingReasons: readonly string[];
  };
}

export function createQueryBillService(deps: QueryBillServiceDeps): QueryBillService {
  function loadOrCreateBill(queryId: string, now: string): QueryBillRecord {
    const existing = deps.bills.findByQueryId(queryId);
    if (existing) return existing;
    const context = deps.queryContexts.findById(queryId);
    if (!context) throw new Error(`unknown_query_context:${queryId}`);
    const link = deps.queryContexts.findTaskLink(queryId);
    const bill: QueryBillRecord = {
      billId: `bill_${queryId}`,
      queryId,
      accountId: context.accountId,
      taskId: link?.costTaskId ?? null,
      conversationId: context.conversationId,
      externalAccountRef: context.externalAccountRef ?? null,
      version: 1,
      state: 'collecting',
      billableBaseNanoCny: { numerator: '0', denominator: '1' },
      amountMicroCoin: '0',
      priceBookVersion: context.priceBookVersion,
      feePolicyVersion: context.feePolicyVersion,
      payerPolicyVersion: context.payerPolicyVersion,
      coverage: 'incomplete',
      coverageNote: null,
      platformAbsorption: null,
      finalizedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    deps.bills.insert(bill, []);
    return bill;
  }

  function collectCosts(
    queryId: string,
    observations: readonly PersistedUsageObservation[],
    book: PriceBookVersion,
    recordedAt: string,
  ): CollectedCost[] {
    return observations.map(observation => {
      const quantity = rational(
        BigInt(observation.quantityNumerator),
        BigInt(observation.quantityDenominator),
      );
      const nonChargeableMeasurement = isNonChargeableMeasurement(observation, quantity);
      const priced = observation.countsTowardTotal
          && !nonChargeableMeasurement
          && observation.quality !== 'unavailable'
        ? costForUsage(book, {
            resource: observation.resource,
            metric: observation.metric,
            quantity,
            agentClassRef: observation.agentClassRef,
            providerRef: observation.providerRef,
            modelId: observation.modelId,
            ...(findPriceUnit(book, {
              resource: observation.resource,
              metric: observation.metric,
              agentClassRef: observation.agentClassRef,
              providerRef: observation.providerRef,
              modelId: observation.modelId,
            })?.sourceCurrency
              ? {
                  sourceCurrency: findPriceUnit(book, {
                    resource: observation.resource,
                    metric: observation.metric,
                    agentClassRef: observation.agentClassRef,
                    providerRef: observation.providerRef,
                    modelId: observation.modelId,
                  })!.sourceCurrency!,
                }
              : {}),
          })
        : null;
      const classification = nonChargeableMeasurement
        ? { disposition: 'absorbed' as const, reason: 'non_chargeable_measurement' }
        : classifyCostEntry({
        payer: observation.payer,
        resource: observation.resource,
        hasPrice: priced !== null,
        quantityIsEstimate: observation.quality === 'estimated',
        usageUnavailable: observation.quality === 'unavailable',
        // 发布价格即表示该执行资源由 MetaWork 提供并运营；用户自付模型时
        // 这部分仍可按已发布规则单独计费。
        metaWorkProvidedResource: priced !== null,
      });
      const costNanoCny = priced?.costNanoCny ?? rational(0n);
      return {
        observation,
        entry: {
          costEntryId: deps.createCostEntryId(observation.observationId, 'reference'),
          observationId: observation.observationId,
          queryId,
          taskId: observation.taskId,
          stage: observation.stage,
          priceBookVersion: book.priceBookVersion,
          payer: observation.payer,
          disposition: classification.disposition,
          reason: classification.reason,
          costKind: 'reference',
          costNanoCny: {
            numerator: costNanoCny.numerator.toString(),
            denominator: costNanoCny.denominator.toString(),
          },
          recordedAt,
          evidenceRef: observation.evidenceRef,
        },
        costNanoCny,
        disposition: classification.disposition,
        reason: classification.reason,
      } satisfies CollectedCost;
    });
  }

  return {
    finalizeQueryBill(input) {
      const existing = deps.bills.findByQueryId(input.queryId);
      if (existing?.state === 'finalized') {
        return { status: 'already_finalized', bill: existing };
      }
      const context = deps.queryContexts.findById(input.queryId);
      if (!context) throw new Error(`unknown_query_context:${input.queryId}`);
      const observations = effectiveObservations(
        context,
        deps.metering.listObservations(input.queryId),
      );
      const spans = deps.metering.listSpans(input.queryId);
      const coverage = coverageFor(observations, spans);
      const book = deps.prices.find(context.priceBookVersion);
      const unsettled = spans.filter(span => span.state !== 'closed');
      const reasons: string[] = [];
      if (!book) reasons.push('price_book_unavailable');
      for (const span of unsettled) {
        reasons.push(`unsettled_call:${span.callId}:${span.state}`);
      }
      for (const span of spans) {
        if (span.state === 'closed' && !observations.some(observation => (
          observation.sourceId === span.sourceId
          && (observation.callId === span.callId || span.sourceId === 'planner')
        ))) reasons.push(`missing_call_usage:${span.sourceId}:${span.callId}`);
      }
      if (observations.length === 0) reasons.push('no_usage_observed');

      const bill = loadOrCreateBill(input.queryId, input.finalizedAt);
      const collected = book
        ? collectCosts(input.queryId, observations, book, input.finalizedAt)
        : [];
      const absorption = input.platformAbsorption ?? null;
      const absorbedCategories = new Set(
        (absorption?.missingCategories ?? []).map(category => category.trim()),
      );
      for (const entry of collected) {
        if (entry.disposition !== 'pending') continue;
        const category = `${entry.observation.resource}:${entry.observation.metric}`;
        if (!absorbedCategories.has(category)) {
          reasons.push(`pending_cost:${category}:${entry.reason}`);
        }
      }
      const pendingReasons = [...new Set(reasons)];
      if (pendingReasons.length > 0) {
        deps.unitOfWork.run(() => {
          deps.costEntries.insert(collected.map(entry => entry.entry));
          deps.bills.markPendingReconciliation(
            bill.billId,
            pendingReasons.join('; '),
            input.finalizedAt,
          );
        });
        return {
          status: 'pending_reconciliation',
          bill: deps.bills.findByQueryId(input.queryId) ?? bill,
          reasons: pendingReasons,
          coverage,
        };
      }
      const eligible = collected.filter(entry => entry.disposition === 'eligible');
      const billableBase = eligible
        .map(entry => entry.costNanoCny)
        .reduce((sum, cost) => addRational(sum, cost), rational(0n));
      const amountMicroCoin = isZeroRational(billableBase)
        ? 0n
        : assessRationalMicroCoin(billableBase, book!.markupBps);
      const lines = distributeStageLines(bill.billId, eligible, amountMicroCoin);
      return deps.unitOfWork.run(() => {
        deps.costEntries.insert(collected.map(entry => entry.entry));
        const outcome = deps.bills.finalize({
          billId: bill.billId,
          billableBaseNanoCny: {
            numerator: billableBase.numerator.toString(),
            denominator: billableBase.denominator.toString(),
          },
          amountMicroCoin: amountMicroCoin.toString(),
          coverage: coverage.coverage,
          coverageNote: coverage.note,
          platformAbsorption: absorption,
          lines,
          finalizedAt: input.finalizedAt,
        });
        const finalizedBill = deps.bills.findByQueryId(input.queryId)!;
        if (outcome === 'finalized' && finalizedBill.amountMicroCoin !== '0') {
          if (deps.exportEnabled() && deps.consumption && finalizedBill.externalAccountRef) {
            enqueueConsumption(deps, finalizedBill, input.finalizedAt);
          }
        }
        return {
          status: outcome === 'finalized' ? 'finalized' as const : 'already_finalized' as const,
          bill: finalizedBill,
        };
      });
    },

    previewQueryUsage(queryId) {
      const context = deps.queryContexts.findById(queryId);
      if (!context) throw new Error(`unknown_query_context:${queryId}`);
      const observations = effectiveObservations(
        context,
        deps.metering.listObservations(queryId),
      );
      const coverage = coverageFor(observations, deps.metering.listSpans(queryId));
      const book = deps.prices.find(context.priceBookVersion);
      if (!book) {
        return { assessedMicroCoin: '0', coverage, pendingReasons: ['price_book_unavailable'] };
      }
      const collected = collectCosts(queryId, observations, book, 'preview');
      const base = collected
        .filter(entry => entry.disposition === 'eligible')
        .map(entry => entry.costNanoCny)
        .reduce((sum, cost) => addRational(sum, cost), rational(0n));
      return {
        assessedMicroCoin: isZeroRational(base)
          ? '0'
          : assessRationalMicroCoin(base, book.markupBps).toString(),
        coverage,
        pendingReasons: [...new Set(collected
          .filter(entry => entry.disposition === 'pending')
          .map(entry => `${entry.observation.resource}:${entry.observation.metric}:${entry.reason}`))],
      };
    },
  };
}

/**
 * Cache/reasoning counters are retained for observability but are subsets of
 * input/output. Older releases wrote cache_write with countsTowardTotal=1;
 * treating the metric as non-chargeable here makes those historical bills
 * safely retryable after an upgrade.
 */
function isNonChargeableMeasurement(
  observation: Pick<PersistedUsageObservation, 'resource' | 'metric' | 'countsTowardTotal' | 'quality'>,
  quantity: Rational,
): boolean {
  if (isZeroRational(quantity)) return true;
  if (observation.resource === 'model_tokens'
    && ['cache_read', 'cache_write', 'reasoning'].includes(observation.metric)) {
    return true;
  }
  return !observation.countsTowardTotal && observation.quality !== 'unavailable';
}

/**
 * Queries accepted before the platform-default payer policy was introduced
 * were recorded as `unknown` solely because the Server environment variable
 * was absent. Keep genuinely explicit unknown payers pending, but repair only
 * those legacy contexts during reconciliation.
 */
function effectiveObservations(
  context: { payerPolicyVersion: string },
  observations: readonly PersistedUsageObservation[],
): PersistedUsageObservation[] {
  if (context.payerPolicyVersion !== 'unknown-v1') return [...observations];
  return observations.map(observation => observation.payer === 'unknown'
    ? { ...observation, payer: 'platform' as const }
    : observation);
}

function coverageFor(
  observations: readonly PersistedUsageObservation[],
  spans: readonly MeteringSpanRecord[],
): CoverageReport {
  if (observations.length === 0) {
    return Object.freeze({
      quality: 'unavailable',
      coverage: 'incomplete',
      observedCategories: [],
      estimatedCategories: [],
      unavailableCategories: [],
      missingCategories: [],
      observedCount: 0,
      missingCount: 0,
      note: 'no usage was observed for this Query',
    });
  }
  const expected = new Map(observations.map(observation => [
    `${observation.resource}:${observation.metric}`,
    { resource: observation.resource, metric: observation.metric },
  ]));
  for (const span of spans) {
    if (span.sourceScope !== 'model_request' && span.sourceScope !== 'harness_turn') continue;
    expected.set('model_tokens:input', { resource: 'model_tokens', metric: 'input' });
    expected.set('model_tokens:output', { resource: 'model_tokens', metric: 'output' });
  }
  return projectCoverage({
    observations: observations.map(observation => ({
      observationId: observation.observationId,
      sourceId: observation.sourceId,
      sourceEventKey: observation.sourceEventKey,
      sourceScope: observation.sourceScope,
      callId: observation.callId,
      queryId: observation.queryId,
      executionSegmentId: observation.executionSegmentId,
      taskId: observation.taskId,
      stage: observation.stage,
      reason: observation.reason,
      resource: observation.resource,
      metric: observation.metric,
      unit: observation.unit,
      quantity: {
        numerator: observation.quantityNumerator,
        denominator: observation.quantityDenominator,
      },
      quality: observation.quality,
      countsTowardTotal: observation.countsTowardTotal,
      payer: observation.payer,
      capturedAt: observation.capturedAt,
      providerBindingVersion: observation.providerBindingVersion,
      evidenceRef: observation.evidenceRef,
      normalizationRuleVersion: observation.normalizationRuleVersion,
    })),
    expected: [...expected.values()],
  });
}

/** 阶段金额由最终总额确定性分配；`null` stage 归入 `unattributed`。 */
function distributeStageLines(
  billId: string,
  eligible: readonly CollectedCost[],
  amountMicroCoin: bigint,
): QueryBillLineRecord[] {
  const weights = new Map<string, Rational>();
  for (const entry of eligible) {
    const stage = entry.observation.stage ?? 'unattributed';
    weights.set(stage, addRational(weights.get(stage) ?? rational(0n), entry.costNanoCny));
  }
  if (weights.size === 0) {
    return [{
      billId,
      lineId: 'unattributed',
      stage: null,
      amountMicroCoin: '0',
      rationale: 'no chargeable cost observed',
    }];
  }
  return distributeByWeights(amountMicroCoin, [...weights.entries()].map(([id, weight]) => ({
    id,
    weight,
  }))).map(row => ({
    billId,
    lineId: row.id,
    stage: row.id === 'unattributed' ? null : row.id,
    amountMicroCoin: row.amount.toString(),
    rationale: 'stage share of the finalized Query total',
  }));
}

function enqueueConsumption(
  deps: QueryBillServiceDeps,
  bill: QueryBillRecord,
  now: string,
): void {
  const outbox = deps.consumption!;
  const sourceInstanceId = outbox.readSourceInstanceId();
  if (!sourceInstanceId) {
    throw new Error('consumption_source_instance_unbound');
  }
  const payload = {
    sourceSystem: 'metawork' as const,
    sourceInstanceId,
    externalAccountRef: bill.externalAccountRef!,
    billId: bill.billId,
    queryId: bill.queryId,
    taskId: bill.taskId,
    version: 1 as const,
    amountMicroCoin: bill.amountMicroCoin,
    priceBookVersion: bill.priceBookVersion,
  };
  const consumptionBill = buildConsumptionBill(payload);
  outbox.insert({
    billId: bill.billId,
    sourceInstanceId,
    externalAccountRef: payload.externalAccountRef,
    payloadJson: canonicalConsumptionPayload(payload),
    payloadDigest: consumptionBill.digest,
    amountMicroCoin: bill.amountMicroCoin,
    state: 'not_exported',
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
}
