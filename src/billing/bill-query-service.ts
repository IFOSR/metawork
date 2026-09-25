/**
 * 只读账单查询服务（ADR-0042 §8）。
 *
 * 三端通过统一 Gateway 的只读查询端口读取投影；服务本身不做计价，只把
 * 已持久事实组合成安全、可比较的展示模型，并显式区分
 * “应计” / “第三方已确认扣款” / “待核对” / “非平台支付成本”。
 */

import {
  addRational,
  assessRationalMicroCoin,
  distributeByWeights,
  formatDecimalUnits,
  isZeroRational,
  rational,
  type Rational,
} from './money.js';
import { classifyCostEntry } from './cost-policy.js';
import { costForUsage, findPriceUnit, type PriceBookVersion } from './pricing.js';
import type {
  BillAdjustmentPort,
  BillStorePort,
  ConsumptionOutboxPort,
  CostEntryRecord,
  ExternalState,
  QueryBillRecord,
  BillUserStatusFilter,
} from './ports.js';
import type {
  MeteringStore,
  PersistedUsageObservation,
  MeteringSpanRecord,
  QueryContextStore,
} from '../metering/ports.js';
import type { PriceStorePort } from './ports.js';

/** 用户可见账单状态：最多三种，内部状态不直接堆叠展示（账单简化设计 §2）。 */
export const BILLING_USER_STATUSES = ['billed', 'unconfirmed', 'no_charge'] as const;
export type QueryBillUserStatus = (typeof BILLING_USER_STATUSES)[number];

/**
 * 稳定诊断码（账单简化设计 §5）。页面主文案使用中文解释；诊断必须区分
 * “没有账单事实”和“有账单事实但前端没有显示”，避免前端静默空白。
 */
export const BILLING_DIAGNOSTIC_CODES = [
  'no_usage_observed',
  'provider_usage_unavailable',
  'usage_parser_no_match',
  'query_not_finalized',
  'missing_price_book',
  'missing_price_rule',
  'payer_unknown',
  'missing_billing_projection',
  'historical_unavailable',
  'external_consumption_disabled',
] as const;
export type BillingDiagnosticCode = (typeof BILLING_DIAGNOSTIC_CODES)[number];

export const BILLING_DIAGNOSTIC_MESSAGES: Readonly<Record<BillingDiagnosticCode, string>> = Object.freeze({
  no_usage_observed: 'Provider 未返回可验证的用量数据',
  provider_usage_unavailable: '当前 Provider 不提供用量数据',
  usage_parser_no_match: '收到了 Provider 输出，但没有匹配到 usage 格式',
  query_not_finalized: '请求仍在等待计量收束',
  missing_price_book: '当前请求缺少有效价格规则',
  missing_price_rule: '已记录 Token，但没有匹配到该 Provider/Model 的输入或输出单价',
  payer_unknown: '已记录 Token，但没有确认本次调用由谁承担费用',
  missing_billing_projection: '账单事实存在，但页面投影暂时不可用',
  historical_unavailable: '历史任务没有足够事实，无法安全补算',
  external_consumption_disabled: '本地账单已生成，但外部消费提交未启用',
});

export interface QueryBillProjection {
  readonly billId: string;
  readonly queryId: string;
  readonly taskId: string | null;
  /** 归属的 Conversation / Turn；来自持久 Query 上下文，供三端关联展示。 */
  readonly turnId: string | null;
  readonly conversationId: string | null;
  readonly createdAt: string;
  readonly priceBookVersion?: string;
  readonly feePolicyVersion?: string;
  readonly state: QueryBillRecord['state'];
  /** 三态用户状态；内部 state 只保留在 Server 与诊断详情中。 */
  readonly userStatus: QueryBillUserStatus;
  /** 最终应计；未终结时为暂计。 */
  readonly assessedMicroCoin: string;
  /** 面向用户的十进制 MetaCoin 展示值。 */
  readonly assessedMetaCoin: string;
  readonly assessedIsFinal: boolean;
  /** 只有外部回执 `applied` 才是已确认扣款。 */
  readonly externalState: ExternalState;
  readonly externalEntryId: string | null;
  readonly confirmedDeductedMicroCoin: string | null;
  readonly confirmedDeductedMetaCoin: string | null;
  readonly coverage: QueryBillRecord['coverage'];
  readonly coverageNote: string | null;
  readonly platformAbsorption: QueryBillRecord['platformAbsorption'];
  readonly payerSummary?: readonly {
    readonly payer: string;
    readonly disposition: 'eligible' | 'absorbed' | 'pending';
  }[];
  readonly lines: readonly {
    readonly stage: string | null;
    readonly amountMicroCoin: string;
    readonly amountMetaCoin: string;
    readonly rationale: string;
  }[];
  readonly adjustments: readonly {
    readonly adjustmentId: string;
    readonly amountMicroCoin: string;
    readonly amountMetaCoin: string;
    readonly reason: string;
    readonly externalState: ExternalState;
  }[];
  readonly finalizedAt: string | null;
  /** 稳定诊断码；null 表示当前没有需要向用户解释的缺失。 */
  readonly diagnosticCode: BillingDiagnosticCode | null;
  /** 诊断码对应的中文用户解释。 */
  readonly diagnosticMessage: string | null;
  /** 该 Query 已持久化的 usage 观测数。 */
  readonly observedUsageCount: number;
  /** 期望但未观测到的用量类别（如 `model_tokens:input`）。 */
  readonly missingCategories: readonly string[];
  readonly usageBreakdown?: readonly {
    readonly agentClassRef: string | null;
    readonly providerRef: string | null;
    readonly modelId: string | null;
    readonly inputTokens: string;
    readonly outputTokens: string;
    readonly cacheReadTokens: string;
    readonly cacheWriteTokens: string;
    readonly totalTokens: string;
  }[];
  /** 按阶段与模型的用户可见明细；金额可在总账单待确认时先显示已确认部分。 */
  readonly stageBreakdown?: readonly {
    readonly stage: string | null;
    readonly agentClassRef: string | null;
    readonly providerRef: string | null;
    readonly modelId: string | null;
    readonly inputTokens: string;
    readonly outputTokens: string;
    readonly cacheReadTokens: string;
    readonly cacheWriteTokens: string;
    readonly totalTokens: string;
    readonly assessedMicroCoin: string | null;
    readonly assessedMetaCoin: string | null;
    readonly costStatus: 'calculated' | 'not_chargeable' | 'pending';
    readonly costReason: string | null;
  }[];
}

/**
 * 单 Turn 的三态账单用户视图（账单简化设计 §3.1）。
 * 每个 Turn 都能拿到视图——无论是否有金额——没有金额时给出稳定原因。
 */
export interface TurnBillUserView {
  readonly turnId: string;
  readonly queryId: string | null;
  readonly conversationId: string | null;
  readonly taskId: string | null;
  readonly userStatus: QueryBillUserStatus;
  /** 页面主文案，如 `本次费用：1.2 MetaCoin`。 */
  readonly headline: string;
  /** 展示金额（MetaCoin 十进制字符串）；null 表示暂无法计算。 */
  readonly amountMicroCoin: string | null;
  readonly amountIsFinal: boolean;
  readonly diagnosticCode: BillingDiagnosticCode | null;
  readonly diagnosticMessage: string | null;
  readonly observedUsageCount: number;
  readonly missingCategories: readonly string[];
  readonly usageBreakdown: NonNullable<QueryBillProjection['usageBreakdown']>;
  readonly stageBreakdown: NonNullable<QueryBillProjection['stageBreakdown']>;
  readonly billId: string | null;
  readonly finalizedAt: string | null;
  readonly projectedAt: string;
}

export interface TaskUsageSummary {
  readonly taskId: string;
  readonly finalizedMicroCoin: string;
  readonly pendingReconciliationMicroCoin: string;
  readonly inFlightMicroCoin: string;
  readonly queryCount: number;
  readonly confirmedDeductedMicroCoin: string;
}

export interface AccountUsageSummary {
  readonly accountId: string;
  readonly finalizedMicroCoin: string;
  readonly pendingReconciliationMicroCoin: string;
  readonly inFlightMicroCoin: string;
  readonly billCount: number;
  readonly confirmedDeductedMicroCoin: string;
}

export interface QueryBillListPage {
  readonly items: readonly QueryBillProjection[];
  readonly nextCursor: string | null;
}

export interface BillQueryServiceDeps {
  readonly bills: BillStorePort;
  readonly adjustments: BillAdjustmentPort;
  readonly consumption: ConsumptionOutboxPort;
  readonly costs?: import('./ports.js').CostEntryPort;
  readonly queryContexts?: QueryContextStore;
  /** 诊断投影事实源：usage 观测与计量 span；缺失时诊断退化为状态推导。 */
  readonly metering?: MeteringStore;
  readonly prices?: PriceStorePort;
  /** 外部消费提交开关；提供后已计费账单可给出 informational 诊断。 */
  readonly exportEnabled?: () => boolean;
  readonly now?: () => string;
}

export interface BillQueryService {
  getQueryBill(queryId: string): QueryBillProjection | null;
  getQueryBillForAccount(accountId: string, queryId: string): QueryBillProjection | null;
  getQueryBillForTurn(accountId: string, turnId: string): QueryBillProjection | null;
  /**
   * 单 Turn 三态账单视图。只在无法归因到任何事实时也返回“历史不可补算”
   * 视图，保证页面永不静默空白；`liveFallback` 标记活跃 Turn 的等待收束。
   */
  getTurnBillUserView(
    accountId: string,
    turnId: string,
    options?: { readonly liveFallback?: boolean },
  ): TurnBillUserView | null;
  listQueryBills(input: {
    readonly accountId: string;
    readonly limit: number;
  }): readonly QueryBillProjection[];
  listQueryBillsPage?(input: {
    readonly accountId: string;
    readonly limit: number;
    readonly filter?: QueryBillUserStatus;
    readonly cursor?: string;
  }): QueryBillListPage;
  /** Task 详情的关联 Query 展示；跨账户越权时返回空列表，不猜测金额。 */
  listQueryBillsForTask(accountId: string, taskId: string): readonly QueryBillProjection[];
  getTaskUsageSummary(taskId: string): TaskUsageSummary;
  getTaskUsageSummaryForAccount(accountId: string, taskId: string): TaskUsageSummary | null;
  getUsageSummary(accountId: string, limit?: number): AccountUsageSummary;
}

interface UsageTotals {
  readonly agentClassRef: string | null;
  readonly providerRef: string | null;
  readonly modelId: string | null;
  inputTokens: Rational;
  outputTokens: Rational;
  cacheReadTokens: Rational;
  cacheWriteTokens: Rational;
}

interface StageUsageTotals extends UsageTotals {
  readonly stage: string | null;
  eligibleCost: Rational;
  pendingReasons: Set<string>;
}

function stageUsageKey(entry: Pick<StageUsageTotals, 'stage' | 'agentClassRef' | 'providerRef' | 'modelId'>): string {
  return JSON.stringify([
    entry.stage,
    entry.agentClassRef,
    entry.providerRef,
    entry.modelId,
  ]);
}

function usageQuantity(observation: PersistedUsageObservation): Rational {
  return rational(
    BigInt(observation.quantityNumerator),
    BigInt(observation.quantityDenominator),
  );
}

function formatTokenQuantity(value: Rational): string {
  return value.denominator === 1n
    ? value.numerator.toString()
    : `${value.numerator}/${value.denominator}`;
}

function projectUsageBreakdown(
  observations: readonly PersistedUsageObservation[],
): QueryBillProjection['usageBreakdown'] {
  const grouped = new Map<string, UsageTotals>();
  for (const observation of observations) {
    if (observation.resource !== 'model_tokens') continue;
    const identity = {
      agentClassRef: observation.agentClassRef ?? null,
      providerRef: observation.providerRef ?? null,
      modelId: observation.modelId ?? null,
    };
    const key = JSON.stringify([
      identity.agentClassRef,
      identity.providerRef,
      identity.modelId,
    ]);
    const current = grouped.get(key) ?? {
      ...identity,
      inputTokens: rational(0n),
      outputTokens: rational(0n),
      cacheReadTokens: rational(0n),
      cacheWriteTokens: rational(0n),
    };
    const quantity = usageQuantity(observation);
    if (observation.metric === 'input') {
      current.inputTokens = addRational(current.inputTokens, quantity);
    } else if (observation.metric === 'output') {
      current.outputTokens = addRational(current.outputTokens, quantity);
    } else if (observation.metric === 'cache_read') {
      current.cacheReadTokens = addRational(current.cacheReadTokens, quantity);
    } else if (observation.metric === 'cache_write') {
      current.cacheWriteTokens = addRational(current.cacheWriteTokens, quantity);
    }
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .sort((left, right) => JSON.stringify([
      left.agentClassRef, left.providerRef, left.modelId,
    ]).localeCompare(JSON.stringify([
      right.agentClassRef, right.providerRef, right.modelId,
    ])))
    .map(entry => ({
      agentClassRef: entry.agentClassRef,
      providerRef: entry.providerRef,
      modelId: entry.modelId,
      inputTokens: formatTokenQuantity(entry.inputTokens),
      outputTokens: formatTokenQuantity(entry.outputTokens),
      cacheReadTokens: formatTokenQuantity(entry.cacheReadTokens),
      cacheWriteTokens: formatTokenQuantity(entry.cacheWriteTokens),
      totalTokens: formatTokenQuantity(addRational(entry.inputTokens, entry.outputTokens)),
    }));
}

function projectStageBreakdown(
  observations: readonly PersistedUsageObservation[],
  costs: readonly CostEntryRecord[],
  book: PriceBookVersion | null,
  finalizedAmountMicroCoin: string | null,
): NonNullable<QueryBillProjection['stageBreakdown']> {
  const grouped = new Map<string, StageUsageTotals>();
  const costByObservation = new Map(costs.map(cost => [cost.observationId, cost]));
  for (const observation of observations) {
    if (observation.resource !== 'model_tokens') continue;
    const identity = {
      stage: observation.stage ?? null,
      agentClassRef: observation.agentClassRef ?? null,
      providerRef: observation.providerRef ?? null,
      modelId: observation.modelId ?? null,
    };
    const key = stageUsageKey(identity);
    const current = grouped.get(key) ?? {
      ...identity,
      inputTokens: rational(0n),
      outputTokens: rational(0n),
      cacheReadTokens: rational(0n),
      cacheWriteTokens: rational(0n),
      eligibleCost: rational(0n),
      pendingReasons: new Set<string>(),
    };
    const quantity = usageQuantity(observation);
    if (observation.metric === 'input') {
      current.inputTokens = addRational(current.inputTokens, quantity);
    } else if (observation.metric === 'output') {
      current.outputTokens = addRational(current.outputTokens, quantity);
    } else if (observation.metric === 'cache_read') {
      current.cacheReadTokens = addRational(current.cacheReadTokens, quantity);
    } else if (observation.metric === 'cache_write') {
      current.cacheWriteTokens = addRational(current.cacheWriteTokens, quantity);
    }

    const persistedCost = costByObservation.get(observation.observationId);
    if (persistedCost?.disposition === 'eligible') {
      current.eligibleCost = addRational(
        current.eligibleCost,
        rational(
          BigInt(persistedCost.costNanoCny.numerator),
          BigInt(persistedCost.costNanoCny.denominator),
        ),
      );
    } else if (persistedCost?.disposition === 'pending') {
      current.pendingReasons.add(persistedCost.reason);
    } else if (book && observation.metric !== 'cache_read'
      && observation.metric !== 'cache_write' && observation.metric !== 'reasoning') {
      const priceUnit = findPriceUnit(book, observation);
      const priced = observation.countsTowardTotal && observation.quality !== 'unavailable'
        ? costForUsage(book, {
            resource: observation.resource,
            metric: observation.metric,
            quantity,
            agentClassRef: observation.agentClassRef,
            providerRef: observation.providerRef,
            modelId: observation.modelId,
            ...(priceUnit?.sourceCurrency ? { sourceCurrency: priceUnit.sourceCurrency } : {}),
          })
        : null;
      const classification = !observation.countsTowardTotal && observation.quality === 'reported'
        ? { disposition: 'absorbed' as const, reason: 'non_authoritative_measurement' }
        : classifyCostEntry({
            payer: observation.payer,
            resource: observation.resource,
            hasPrice: priced !== null,
            quantityIsEstimate: observation.quality === 'estimated',
            usageUnavailable: observation.quality === 'unavailable',
            metaWorkProvidedResource: priced !== null,
          });
      if (classification.disposition === 'eligible' && priced) {
        current.eligibleCost = addRational(current.eligibleCost, priced.costNanoCny);
      } else if (classification.disposition === 'pending') {
        current.pendingReasons.add(classification.reason);
      }
    }
    grouped.set(key, current);
  }

  const entries = [...grouped.values()]
    .sort((left, right) => JSON.stringify([
      left.stage, left.agentClassRef, left.providerRef, left.modelId,
    ]).localeCompare(JSON.stringify([
      right.stage, right.agentClassRef, right.providerRef, right.modelId,
    ])));
  const fallbackAmounts = new Map<string, bigint>();
  if (!book && finalizedAmountMicroCoin !== null) {
    const shares = entries
      .filter(entry => !isZeroRational(entry.eligibleCost))
      .map(entry => ({ id: stageUsageKey(entry), weight: entry.eligibleCost }));
    if (shares.length > 0) {
      for (const share of distributeByWeights(BigInt(finalizedAmountMicroCoin), shares)) {
        fallbackAmounts.set(share.id, share.amount);
      }
    }
  }

  return entries
    .map(entry => {
      const totalTokens = addRational(entry.inputTokens, entry.outputTokens);
      const assessed = book && !isZeroRational(entry.eligibleCost)
        ? assessRationalMicroCoin(entry.eligibleCost, book.markupBps)
        : fallbackAmounts.get(stageUsageKey(entry)) ?? null;
      const costStatus = entry.pendingReasons.size > 0
        ? 'pending' as const
        : !isZeroRational(entry.eligibleCost)
          ? 'calculated' as const
          : 'not_chargeable' as const;
      return {
        stage: entry.stage,
        agentClassRef: entry.agentClassRef,
        providerRef: entry.providerRef,
        modelId: entry.modelId,
        inputTokens: formatTokenQuantity(entry.inputTokens),
        outputTokens: formatTokenQuantity(entry.outputTokens),
        cacheReadTokens: formatTokenQuantity(entry.cacheReadTokens),
        cacheWriteTokens: formatTokenQuantity(entry.cacheWriteTokens),
        totalTokens: formatTokenQuantity(totalTokens),
        assessedMicroCoin: costStatus === 'not_chargeable' || assessed === null ? null : assessed.toString(),
        assessedMetaCoin: costStatus === 'not_chargeable' || assessed === null
          ? null
          : formatDecimalUnits(assessed, 6),
        costStatus,
        costReason: entry.pendingReasons.size > 0
          ? [...entry.pendingReasons].sort().join(', ')
          : null,
      };
    });
}

export function createBillQueryService(deps: BillQueryServiceDeps): BillQueryService {
  const now = deps.now ?? (() => new Date().toISOString());

  /**
   * 从持久计量事实推导稳定诊断（账单简化设计 §5）。
   * 只读，不改变账单状态；区分“没有观测”与“有输出但格式未匹配”。
   */
  function diagnoseFacts(
    bill: Pick<QueryBillRecord, 'state' | 'coverageNote' | 'amountMicroCoin'>,
    observations: readonly PersistedUsageObservation[],
    spans: readonly MeteringSpanRecord[],
  ): {
    diagnosticCode: BillingDiagnosticCode | null;
    observedUsageCount: number;
    missingCategories: string[];
  } {
    const observedUsageCount = observations.length;
    const observedKeys = new Set(observations.map(o => `${o.resource}:${o.metric}`));
    const missingCategories = new Set<string>();
    let hasModelCall = false;
    for (const span of spans) {
      if (span.sourceScope === 'model_request' || span.sourceScope === 'harness_turn') {
        hasModelCall = true;
      }
      // 已收束的调用没有任何对应观测：Provider 有输出但没有匹配到 usage 格式。
      const hasMatchingObservation = observations.some(o =>
        o.sourceId === span.sourceId
        && (o.callId === span.callId || span.sourceId === 'planner')
      );
      if (span.state === 'closed' && !hasMatchingObservation) {
        missingCategories.add(`call:${span.sourceId}:${span.callId}`);
      }
    }
    if (hasModelCall) {
      for (const key of ['model_tokens:input', 'model_tokens:output']) {
        if (!observedKeys.has(key)) missingCategories.add(key);
      }
    }

    const note = bill.coverageNote ?? '';
    let diagnosticCode: BillingDiagnosticCode | null = null;
    if (bill.state === 'collecting') {
      diagnosticCode = 'query_not_finalized';
    } else if (bill.state === 'pending_reconciliation') {
      if (note.includes('price_book_unavailable')) diagnosticCode = 'missing_price_book';
      else if (note.includes('price_unavailable')) diagnosticCode = 'missing_price_rule';
      else if (note.includes('payer_unknown')) diagnosticCode = 'payer_unknown';
      else if (note.includes('no_usage_observed')) diagnosticCode = 'no_usage_observed';
      else if (note.includes('usage_unavailable')) diagnosticCode = 'provider_usage_unavailable';
      else if (note.includes('missing_call_usage')) diagnosticCode = 'usage_parser_no_match';
      else diagnosticCode = 'query_not_finalized';
    } else if (bill.state === 'finalized' && bill.amountMicroCoin !== '0') {
      if (deps.exportEnabled && !deps.exportEnabled()) {
        diagnosticCode = 'external_consumption_disabled';
      }
    }
    return { diagnosticCode, observedUsageCount, missingCategories: [...missingCategories] };
  }

  function userStatusFor(bill: QueryBillRecord): QueryBillUserStatus {
    if (bill.state !== 'finalized') return 'unconfirmed';
    try {
      return BigInt(bill.amountMicroCoin) > 0n ? 'billed' : 'no_charge';
    } catch {
      return 'unconfirmed';
    }
  }

  function project(bill: QueryBillRecord): QueryBillProjection {
    const outbox = deps.consumption.find(bill.billId);
    const receipt = deps.consumption.latestReceipt(bill.billId);
    const confirmed = receipt?.state === 'applied' ? receipt.appliedAmountMicroCoin : null;
    const payerTotals = new Map<string, 'eligible' | 'absorbed' | 'pending'>();
    for (const entry of deps.costs?.listForQuery(bill.queryId) ?? []) {
      payerTotals.set(`${entry.payer}:${entry.disposition}`, entry.disposition);
    }
    const context = deps.queryContexts?.findById(bill.queryId) ?? null;
    const observations = deps.metering?.listObservations(bill.queryId) ?? [];
    const spans = deps.metering?.listSpans(bill.queryId) ?? [];
    const costs = deps.costs?.listForQuery(bill.queryId) ?? [];
    const diagnosis = diagnoseFacts(bill, observations, spans);
    const usageBreakdown = projectUsageBreakdown(observations);
    const stageBreakdown = projectStageBreakdown(
      observations,
      costs,
      context && deps.prices ? deps.prices.find(context.priceBookVersion) : null,
      bill.state === 'finalized' ? bill.amountMicroCoin : null,
    );
    return {
      billId: bill.billId,
      queryId: bill.queryId,
      taskId: bill.taskId,
      turnId: context?.turnId ?? null,
      conversationId: bill.conversationId,
      createdAt: bill.createdAt,
      priceBookVersion: bill.priceBookVersion,
      feePolicyVersion: bill.feePolicyVersion,
      state: bill.state,
      userStatus: userStatusFor(bill),
      assessedMicroCoin: bill.amountMicroCoin,
      assessedMetaCoin: formatDecimalUnits(BigInt(bill.amountMicroCoin), 6),
      assessedIsFinal: bill.state === 'finalized',
      externalState: outbox?.state ?? 'not_exported',
      externalEntryId: receipt?.externalEntryId ?? null,
      confirmedDeductedMicroCoin: confirmed,
      confirmedDeductedMetaCoin: confirmed === null
        ? null
        : formatDecimalUnits(BigInt(confirmed), 6),
      coverage: bill.coverage,
      coverageNote: bill.coverageNote,
      platformAbsorption: bill.platformAbsorption,
      payerSummary: [...payerTotals.entries()].map(([key, disposition]) => ({
        payer: key.split(':', 1)[0]!,
        disposition,
      })),
      lines: deps.bills.listLines(bill.billId).map(line => ({
        stage: line.stage,
        amountMicroCoin: line.amountMicroCoin,
        amountMetaCoin: formatDecimalUnits(BigInt(line.amountMicroCoin), 6),
        rationale: line.rationale,
      })),
      adjustments: deps.adjustments.listForBill(bill.billId).map(adjustment => ({
        adjustmentId: adjustment.adjustmentId,
        amountMicroCoin: adjustment.amountMicroCoin,
        amountMetaCoin: formatDecimalUnits(BigInt(adjustment.amountMicroCoin), 6),
        reason: adjustment.reason,
        externalState: adjustment.externalState,
      })),
      finalizedAt: bill.finalizedAt,
      diagnosticCode: diagnosis.diagnosticCode,
      diagnosticMessage: diagnosis.diagnosticCode
        ? BILLING_DIAGNOSTIC_MESSAGES[diagnosis.diagnosticCode]
        : null,
      observedUsageCount: diagnosis.observedUsageCount,
      missingCategories: diagnosis.missingCategories,
      usageBreakdown,
      stageBreakdown,
    };
  }

  /**
   * 三态用户视图主文案（账单简化设计 §2）。
   * 金额展示是纯格式化（microCoin → MetaCoin 十进制），金额本身仍只来自 Server 投影。
   */
  function turnViewFromProjection(
    turnId: string,
    bill: QueryBillProjection,
    projectedAt: string,
  ): TurnBillUserView {
    const amount = formatDecimalUnits(BigInt(bill.assessedMicroCoin), 6);
    const headline = bill.userStatus === 'billed'
      ? `本次费用：${amount} MetaCoin`
      : bill.userStatus === 'no_charge' ? '本次无费用' : '费用暂时无法确认';
    return {
      turnId,
      queryId: bill.queryId,
      conversationId: bill.conversationId,
      taskId: bill.taskId,
      userStatus: bill.userStatus,
      headline,
      amountMicroCoin: bill.userStatus === 'unconfirmed' ? null : amount,
      amountIsFinal: bill.assessedIsFinal,
      diagnosticCode: bill.diagnosticCode,
      diagnosticMessage: bill.diagnosticMessage,
      observedUsageCount: bill.observedUsageCount,
      missingCategories: bill.missingCategories,
      usageBreakdown: bill.usageBreakdown ?? [],
      stageBreakdown: bill.stageBreakdown ?? [],
      billId: bill.billId,
      finalizedAt: bill.finalizedAt,
      projectedAt,
    };
  }

  return {
    getQueryBill(queryId) {
      const bill = deps.bills.findByQueryId(queryId);
      return bill ? project(bill) : null;
    },

    getQueryBillForAccount(accountId, queryId) {
      const bill = deps.bills.findByQueryId(queryId);
      return bill && bill.accountId === accountId ? project(bill) : null;
    },

    getQueryBillForTurn(accountId, turnId) {
      const context = deps.queryContexts?.findByTurnId(accountId, turnId);
      return context ? this.getQueryBillForAccount(accountId, context.queryId) : null;
    },

    getTurnBillUserView(accountId, turnId, options) {
      const context = deps.queryContexts?.findByTurnId(accountId, turnId) ?? null;
      const bill = context ? deps.bills.findByQueryId(context.queryId) : null;
      if (bill && bill.accountId !== accountId) return null;
      const projectedAt = now();
      if (bill) return turnViewFromProjection(turnId, project(bill), projectedAt);
      // 没有 Query 事实（历史 Turn 先于计量存在）：不猜测金额，不追溯补算。
      if (!context) {
        const code: BillingDiagnosticCode = options?.liveFallback
          ? 'query_not_finalized'
          : 'historical_unavailable';
        return {
          turnId,
          queryId: null,
          conversationId: null,
          taskId: null,
          userStatus: 'unconfirmed',
          headline: '费用暂时无法确认',
          amountMicroCoin: null,
          amountIsFinal: false,
          diagnosticCode: code,
          diagnosticMessage: BILLING_DIAGNOSTIC_MESSAGES[code],
          observedUsageCount: 0,
          missingCategories: [],
          usageBreakdown: [],
          stageBreakdown: [],
          billId: null,
          finalizedAt: null,
          projectedAt,
        };
      }
      // Query 已建立但账单行尚未创建（finalize 前的正常窗口）：等待计量收束。
      return {
        turnId,
        queryId: context.queryId,
        conversationId: context.conversationId,
        taskId: deps.queryContexts?.findTaskLink(context.queryId)?.costTaskId ?? null,
        userStatus: 'unconfirmed',
        headline: '费用暂时无法确认',
        amountMicroCoin: null,
        amountIsFinal: false,
        diagnosticCode: 'query_not_finalized',
        diagnosticMessage: BILLING_DIAGNOSTIC_MESSAGES.query_not_finalized,
        observedUsageCount: deps.metering?.listObservations(context.queryId).length ?? 0,
        missingCategories: [],
        usageBreakdown: projectUsageBreakdown(
          deps.metering?.listObservations(context.queryId) ?? [],
        ) ?? [],
        stageBreakdown: projectStageBreakdown(
          deps.metering?.listObservations(context.queryId) ?? [],
          deps.costs?.listForQuery(context.queryId) ?? [],
          deps.prices?.find(context.priceBookVersion) ?? null,
          null,
        ),
        billId: null,
        finalizedAt: null,
        projectedAt,
      };
    },

    listQueryBillsForTask(accountId, taskId) {
      const bills = deps.bills.listBillsForTask(taskId)
        .filter(bill => bill.accountId === accountId);
      return bills.map(project);
    },

    listQueryBills(input) {
      if (input.limit <= 0) return [];
      return deps.bills.listBillsForAccount(input.accountId, input.limit).map(project);
    },

    listQueryBillsPage(input) {
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
        return { items: [], nextCursor: null };
      }
      const before = decodeCursor(input.cursor);
      const rows = deps.bills.listBillsForAccountPage({
        accountId: input.accountId,
        limit: input.limit + 1,
        ...(input.filter ? { userStatus: input.filter as BillUserStatusFilter } : {}),
        ...(before ? { before } : {}),
      });
      const page = rows.slice(0, input.limit).map(project);
      const last = rows[input.limit - 1];
      return {
        items: page,
        nextCursor: rows.length > input.limit && last
          ? encodeCursor({ createdAt: last.createdAt, billId: last.billId })
          : null,
      };
    },

    /** Task 汇总只相加已分配 Query 的最终金额；进行中与待核对另列。 */
    getTaskUsageSummary(taskId) {
      const bills = deps.bills.listBillsForTask(taskId);
      let finalized = 0n;
      let pending = 0n;
      let inFlight = 0n;
      let confirmed = 0n;
      for (const bill of bills) {
        if (bill.state === 'finalized') finalized += BigInt(bill.amountMicroCoin);
        else if (bill.state === 'pending_reconciliation') pending += BigInt(bill.amountMicroCoin);
        else inFlight += BigInt(bill.amountMicroCoin);
        const receipt = deps.consumption.latestReceipt(bill.billId);
        if (receipt?.state === 'applied' && receipt.appliedAmountMicroCoin) {
          confirmed += BigInt(receipt.appliedAmountMicroCoin);
        }
      }
      return {
        taskId,
        finalizedMicroCoin: finalized.toString(),
        pendingReconciliationMicroCoin: pending.toString(),
        inFlightMicroCoin: inFlight.toString(),
        queryCount: bills.length,
        confirmedDeductedMicroCoin: confirmed.toString(),
      };
    },

    getTaskUsageSummaryForAccount(accountId, taskId) {
      const bills = deps.bills.listBillsForTask(taskId);
      if (bills.length === 0 || bills.some(bill => bill.accountId !== accountId)) return null;
      return this.getTaskUsageSummary(taskId);
    },

    /**
     * 账户汇总直接来自账单行，不叠加“Query 明细 + Task 汇总”两套数据，
     * 因此同一 Query 不会被累计两次。
     */
    getUsageSummary(accountId) {
      const bills = deps.bills.listBillsForAccount(accountId);
      let finalized = 0n;
      let pending = 0n;
      let inFlight = 0n;
      let confirmed = 0n;
      for (const bill of bills) {
        if (bill.state === 'finalized') finalized += BigInt(bill.amountMicroCoin);
        else if (bill.state === 'pending_reconciliation') pending += BigInt(bill.amountMicroCoin);
        else inFlight += BigInt(bill.amountMicroCoin);
        const receipt = deps.consumption.latestReceipt(bill.billId);
        if (receipt?.state === 'applied' && receipt.appliedAmountMicroCoin) {
          confirmed += BigInt(receipt.appliedAmountMicroCoin);
        }
      }
      return {
        accountId,
        finalizedMicroCoin: finalized.toString(),
        pendingReconciliationMicroCoin: pending.toString(),
        inFlightMicroCoin: inFlight.toString(),
        billCount: bills.length,
        confirmedDeductedMicroCoin: confirmed.toString(),
      };
    },
  };
}

function encodeCursor(cursor: { createdAt: string; billId: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { createdAt: string; billId: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      billId?: unknown;
    };
    if (
      typeof parsed.createdAt !== 'string'
      || parsed.createdAt.length === 0
      || typeof parsed.billId !== 'string'
      || parsed.billId.length === 0
    ) {
      throw new Error('invalid_cursor');
    }
    return { createdAt: parsed.createdAt, billId: parsed.billId };
  } catch {
    throw new Error('invalid_billing_cursor');
  }
}
