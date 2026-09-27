import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBillingHarness,
  insertObservation,
  linkTask,
  PLATFORM_PRICE_BOOK,
  seedPriceBook,
  type BillingHarness,
} from './harness.js';
import {
  createBillQueryService,
  BILLING_DIAGNOSTIC_MESSAGES,
} from '../../src/billing/bill-query-service.js';
import type { QueryUsageContext } from '../../src/metering/ports.js';

let harness: BillingHarness;

beforeEach(() => {
  harness = createBillingHarness();
  seedPriceBook(harness);
});

afterEach(() => {
  harness.close();
});

/** 建立 带TurnId 的 Query 上下文，验证 Turn 级三态账单视图。 */
function beginQueryWithTurn(input: {
  readonly queryId: string;
  readonly turnId: string;
  readonly accountId?: string;
  readonly conversationId?: string;
}): void {
  const context: QueryUsageContext = {
    queryId: input.queryId,
    accountId: input.accountId ?? 'account-1',
    ingress: 'web',
    requestKey: `req-${input.queryId}`,
    requestPayloadDigest: `digest-${input.queryId}`,
    conversationId: input.conversationId ?? 'conversation-1',
    requestId: `request-${input.queryId}`,
    turnId: input.turnId,
    executionSegmentId: null,
    priceBookVersion: PLATFORM_PRICE_BOOK.priceBookVersion,
    feePolicyVersion: PLATFORM_PRICE_BOOK.feePolicyVersion,
    payerPolicyVersion: PLATFORM_PRICE_BOOK.payerPolicyVersion,
    acceptedAt: '2026-09-21T10:00:00.000Z',
  };
  harness.contexts.insert(context);
}

function createUserProjection() {
  return createBillQueryService({
    bills: harness.bills,
    adjustments: harness.adjustments,
    consumption: harness.outbox,
    costs: harness.costEntries,
    queryContexts: harness.contexts,
    metering: harness.metering,
    prices: harness.prices,
    exportEnabled: () => false,
    now: () => '2026-09-22T00:00:00.000Z',
  });
}

describe('三态用户状态与稳定诊断投影（账单简化设计 §2/§5）', () => {
  it('终结且金额为正的账单投影为已计费', () => {
    beginQueryWithTurn({ queryId: 'q1', turnId: 'turn-1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    const view = createUserProjection().getTurnBillUserView('account-1', 'turn-1');
    expect(view?.userStatus).toBe('billed');
    expect(view?.headline).toBe('本次费用：0.000028 MetaCoin');
    expect(view?.amountMicroCoin).toBe('0.000028');
    expect(createUserProjection().getQueryBill('q1')?.assessedMetaCoin).toBe('0.000028');
    expect(view?.amountIsFinal).toBe(true);
    expect(view?.diagnosticCode).toBe('external_consumption_disabled');
    expect(view?.diagnosticMessage).toBe(
      BILLING_DIAGNOSTIC_MESSAGES.external_consumption_disabled,
    );
  });

  it('projects token usage grouped by AgentClass, Provider and Model', () => {
    beginQueryWithTurn({ queryId: 'q1', turnId: 'turn-1' });
    insertObservation(harness, {
      queryId: 'q1',
      metric: 'input',
      quantity: '139',
      agentClassRef: 'planner',
      providerRef: 'deepseek',
      modelId: 'deepseek-flash',
    });
    insertObservation(harness, {
      queryId: 'q1',
      metric: 'output',
      quantity: '1733',
      agentClassRef: 'planner',
      providerRef: 'deepseek',
      modelId: 'deepseek-flash',
    });
    harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });

    expect(createUserProjection().getQueryBill('q1')?.usageBreakdown).toEqual([{
      agentClassRef: 'planner',
      providerRef: 'deepseek',
      modelId: 'deepseek-flash',
      inputTokens: '139',
      outputTokens: '1733',
      cacheReadTokens: '0',
      cacheWriteTokens: '0',
      totalTokens: '1872',
    }]);
    expect(createUserProjection().getTurnBillUserView('account-1', 'turn-1')?.usageBreakdown)
      .toEqual([{
        agentClassRef: 'planner',
        providerRef: 'deepseek',
        modelId: 'deepseek-flash',
        inputTokens: '139',
        outputTokens: '1733',
        cacheReadTokens: '0',
        cacheWriteTokens: '0',
        totalTokens: '1872',
      }]);
  });

  it('终结且金额为零的账单投影为无费用', () => {
    beginQueryWithTurn({ queryId: 'q1', turnId: 'turn-1' });
    insertObservation(harness, {
      queryId: 'q1', metric: 'input', quantity: '1000', payer: 'system',
    });
    harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    const projection = createUserProjection().getQueryBill('q1');
    expect(projection?.userStatus).toBe('no_charge');
    const view = createUserProjection().getTurnBillUserView('account-1', 'turn-1');
    expect(view?.userStatus).toBe('no_charge');
    expect(view?.headline).toBe('本次无费用');
  });

  it('Query 已建立但账单行未创建时投影为待确认/等待计量收束', () => {
    beginQueryWithTurn({ queryId: 'q1', turnId: 'turn-1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    const view = createUserProjection().getTurnBillUserView('account-1', 'turn-1');
    expect(view?.userStatus).toBe('unconfirmed');
    expect(view?.diagnosticCode).toBe('query_not_finalized');
    expect(view?.amountMicroCoin).toBeNull();
    expect(view?.headline).toBe('费用暂时无法确认');
    expect(view?.queryId).toBe('q1');
  });

  it('没有 usage 的终结尝试投影为待确认/no_usage_observed，绝不静默空白', () => {
    beginQueryWithTurn({ queryId: 'q1', turnId: 'turn-1' });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status).toBe('pending_reconciliation');
    const projection = createUserProjection().getQueryBill('q1');
    expect(projection?.userStatus).toBe('unconfirmed');
    expect(projection?.diagnosticCode).toBe('no_usage_observed');
    expect(projection?.diagnosticMessage).toBe(BILLING_DIAGNOSTIC_MESSAGES.no_usage_observed);
    expect(projection?.observedUsageCount).toBe(0);
  });

  it('价格规则缺失的终结尝试投影为 missing_price_book', () => {
    harness.contexts.insert({
      queryId: 'q2',
      accountId: 'account-1',
      ingress: 'web',
      requestKey: 'req-q2',
      requestPayloadDigest: 'digest-q2',
      conversationId: 'conversation-1',
      requestId: 'request-q2',
      turnId: 'turn-2',
      executionSegmentId: null,
      priceBookVersion: 'unconfigured',
      feePolicyVersion: PLATFORM_PRICE_BOOK.feePolicyVersion,
      payerPolicyVersion: PLATFORM_PRICE_BOOK.payerPolicyVersion,
      acceptedAt: '2026-09-21T10:00:00.000Z',
    });
    insertObservation(harness, { queryId: 'q2', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({
      queryId: 'q2',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    const projection = createUserProjection().getQueryBill('q2');
    expect(projection?.diagnosticCode).toBe('missing_price_book');
    expect(projection?.userStatus).toBe('unconfirmed');
  });

  it('closed 调用无对应观测时投影为 usage_parser_no_match', () => {
    beginQueryWithTurn({ queryId: 'q1', turnId: 'turn-1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    // 另一个已收束调用没有产生任何观测：Provider 有输出但格式未匹配
    harness.metering.openSpan({
      spanId: 'span-orphan',
      queryId: 'q1',
      executionSegmentId: null,
      sourceId: 'executor',
      sourceScope: 'model_request',
      callId: 'call-orphan',
      stage: 'execution',
      reason: 'primary',
      state: 'closed',
      payer: 'platform',
      startedAt: '2026-09-21T10:00:00.000Z',
      closedAt: '2026-09-21T10:00:30.000Z',
    });
    harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    const projection = createUserProjection().getQueryBill('q1');
    expect(projection?.diagnosticCode).toBe('usage_parser_no_match');
    expect(projection?.missingCategories).toContain('call:executor:call-orphan');
  });

  it('does not report a missing price for a cache-write subset', () => {
    beginQueryWithTurn({ queryId: 'q1', turnId: 'turn-1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    insertObservation(harness, {
      queryId: 'q1', metric: 'output', quantity: '500', suffix: 'output',
    });
    insertObservation(harness, {
      queryId: 'q1',
      metric: 'cache_write',
      quantity: '1000',
      countsTowardTotal: true,
      suffix: 'cache-write',
    });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status).toBe('finalized');
    const projection = createUserProjection().getQueryBill('q1');
    expect(projection?.userStatus).toBe('billed');
    expect(projection?.diagnosticCode).toBe('external_consumption_disabled');
  });

  it('projects Planner and Executor usage and cost while another metric is pending', () => {
    beginQueryWithTurn({ queryId: 'q-stages', turnId: 'turn-stages' });
    insertObservation(harness, {
      queryId: 'q-stages', metric: 'input', quantity: '1000', stage: 'planning',
      agentClassRef: 'planner', providerRef: 'deepseek', modelId: 'deepseek-flash',
      suffix: 'planner-input',
    });
    insertObservation(harness, {
      queryId: 'q-stages', metric: 'output', quantity: '500', stage: 'planning',
      agentClassRef: 'planner', providerRef: 'deepseek', modelId: 'deepseek-flash',
      suffix: 'planner-output',
    });
    insertObservation(harness, {
      queryId: 'q-stages', metric: 'input', quantity: '2000', stage: 'execution',
      agentClassRef: 'executor', providerRef: 'deepseek', modelId: 'deepseek-flash',
      suffix: 'executor-input',
    });
    insertObservation(harness, {
      queryId: 'q-stages', metric: 'output', quantity: '250', stage: 'execution',
      agentClassRef: 'executor', providerRef: 'deepseek', modelId: 'deepseek-flash',
      suffix: 'executor-output',
    });
    insertObservation(harness, {
      queryId: 'q-stages', metric: 'request', resource: 'search', quantity: '1',
      stage: 'execution', suffix: 'pending-search',
    });
    harness.billService.finalizeQueryBill({
      queryId: 'q-stages',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });

    const projection = createUserProjection().getQueryBill('q-stages');
    expect(projection?.userStatus).toBe('unconfirmed');
    expect(projection?.stageBreakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'planning',
        agentClassRef: 'planner',
        inputTokens: '1000',
        outputTokens: '500',
        assessedMetaCoin: '0.00007',
        costStatus: 'calculated',
      }),
      expect.objectContaining({
        stage: 'execution',
        agentClassRef: 'executor',
        inputTokens: '2000',
        outputTokens: '250',
        assessedMetaCoin: '0.000077',
        costStatus: 'calculated',
      }),
    ]));
  });

  it('uses persisted cost entries for stage fees when the price directory is temporarily unavailable', () => {
    beginQueryWithTurn({ queryId: 'q-persisted-cost', turnId: 'turn-persisted-cost' });
    insertObservation(harness, {
      queryId: 'q-persisted-cost',
      metric: 'input',
      quantity: '1000',
      stage: 'planning',
      agentClassRef: 'planner',
      providerRef: 'deepseek',
      modelId: 'deepseek-flash',
    });
    harness.billService.finalizeQueryBill({
      queryId: 'q-persisted-cost',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });

    const projection = createBillQueryService({
      bills: harness.bills,
      adjustments: harness.adjustments,
      consumption: harness.outbox,
      costs: harness.costEntries,
      queryContexts: harness.contexts,
      metering: harness.metering,
      prices: {
        find: () => null,
      },
      exportEnabled: () => false,
    }).getQueryBill('q-persisted-cost');

    expect(projection?.assessedMetaCoin).toBe('0.000028');
    expect(projection?.stageBreakdown).toEqual([
      expect.objectContaining({
        stage: 'planning',
        agentClassRef: 'planner',
        assessedMetaCoin: '0.000028',
        costStatus: 'calculated',
      }),
    ]);
  });

  it('explains an unknown payer even when usage and prices are available', () => {
    beginQueryWithTurn({ queryId: 'q1', turnId: 'turn-1' });
    insertObservation(harness, {
      queryId: 'q1', metric: 'input', quantity: '1000', payer: 'unknown',
    });
    harness.billService.finalizeQueryBill({
      queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(createUserProjection().getQueryBill('q1')).toMatchObject({
      userStatus: 'unconfirmed',
      diagnosticCode: 'payer_unknown',
      diagnosticMessage: expect.stringContaining('承担费用'),
    });
  });

  it('allows multiple Planner message calls to belong to one Query span', () => {
    beginQueryWithTurn({ queryId: 'q1', turnId: 'turn-1' });
    harness.metering.openSpan({
      spanId: 'span-planner-query',
      queryId: 'q1',
      executionSegmentId: null,
      sourceId: 'planner',
      sourceScope: 'model_request',
      callId: 'planner:q1',
      stage: 'planning',
      reason: 'primary',
      state: 'closed',
      payer: 'platform',
      startedAt: '2026-09-21T10:00:00.000Z',
      closedAt: '2026-09-21T10:00:30.000Z',
    });
    insertObservation(harness, {
      queryId: 'q1',
      metric: 'input',
      quantity: '1000',
      sourceId: 'planner',
      suffix: 'message_end:assistant-1',
    });
    harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });

    expect(createUserProjection().getQueryBill('q1')?.diagnosticCode).not.toBe(
      'usage_parser_no_match',
    );
  });

  it('历史 Turn 没有 Query 事实时投影为 historical_unavailable，不猜测金额', () => {
    const view = createUserProjection().getTurnBillUserView('account-1', 'turn-ancient');
    expect(view?.userStatus).toBe('unconfirmed');
    expect(view?.diagnosticCode).toBe('historical_unavailable');
    expect(view?.amountMicroCoin).toBeNull();
    expect(view?.queryId).toBeNull();
  });

  it('活跃 Turn 无事实时使用 query_not_finalized 回退', () => {
    const view = createUserProjection().getTurnBillUserView('account-1', 'turn-live', {
      liveFallback: true,
    });
    expect(view?.diagnosticCode).toBe('query_not_finalized');
  });

  it('跨账户 Turn 不泄露任何账单事实', () => {
    beginQueryWithTurn({ queryId: 'q1', turnId: 'turn-1', accountId: 'account-1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    const foreign = createUserProjection().getTurnBillUserView('account-2', 'turn-1');
    // 无本账户事实时允许返回通用历史视图，但绝不携带他账户的 Query/金额。
    expect(foreign?.queryId).toBeNull();
    expect(foreign?.taskId).toBeNull();
    expect(foreign?.amountMicroCoin).toBeNull();
    expect(foreign?.billId).toBeNull();
    expect(foreign?.observedUsageCount).toBe(0);
  });

  it('导出启用时已计费账单无 informational 诊断', () => {
    beginQueryWithTurn({ queryId: 'q1', turnId: 'turn-1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    const projection = createBillQueryService({
      bills: harness.bills,
      adjustments: harness.adjustments,
      consumption: harness.outbox,
      costs: harness.costEntries,
      queryContexts: harness.contexts,
      metering: harness.metering,
      prices: harness.prices,
      exportEnabled: () => true,
    }).getQueryBill('q1');
    expect(projection?.userStatus).toBe('billed');
    expect(projection?.diagnosticCode).toBeNull();
    expect(projection?.diagnosticMessage).toBeNull();
  });
});

describe('Task 关联 Query 展示（账单简化设计 §3.3/§4）', () => {
  it('按账户授权列出同 Task 的全部 Query，并保持三态投影', () => {
    beginQueryWithTurn({ queryId: 'q1', turnId: 'turn-1' });
    beginQueryWithTurn({ queryId: 'q2', turnId: 'turn-2' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    // q2 无 usage：终结尝试产生待核对账单行，对应设计 §3.3 的待确认行。
    linkTask(harness, 'q1', 'task-1');
    linkTask(harness, 'q2', 'task-1');
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    harness.billService.finalizeQueryBill({ queryId: 'q2', finalizedAt: '2026-09-21T10:01:00.000Z' });
    const service = createUserProjection();
    const items = service.listQueryBillsForTask('account-1', 'task-1');
    expect(items.map(bill => bill.queryId).sort()).toEqual(['q1', 'q2']);
    expect(items.find(bill => bill.queryId === 'q1')?.userStatus).toBe('billed');
    expect(items.find(bill => bill.queryId === 'q2')?.userStatus).toBe('unconfirmed');
    expect(items.find(bill => bill.queryId === 'q1')?.turnId).toBe('turn-1');
    expect(items.find(bill => bill.queryId === 'q1')?.conversationId).toBe('conversation-1');
  });

  it('跨账户 Task 账单不投影', () => {
    beginQueryWithTurn({ queryId: 'q1', turnId: 'turn-1', accountId: 'account-2' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    linkTask(harness, 'q1', 'task-1');
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    expect(createUserProjection().listQueryBillsForTask('account-1', 'task-1')).toEqual([]);
  });

  it('没有 Query 事实的 Task 返回空列表，由页面显示未建立计量记录', () => {
    expect(createUserProjection().listQueryBillsForTask('account-1', 'task-none')).toEqual([]);
  });
});
