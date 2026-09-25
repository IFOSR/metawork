import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginQuery,
  createBillingHarness,
  insertObservation,
  linkTask,
  PLATFORM_PRICE_BOOK,
  seedPriceBook,
  type BillingHarness,
} from './harness.js';
import { validatePlatformAbsorption } from '../../src/billing/cost-policy.js';
import { createQueryContextService } from '../../src/metering/query-context-service.js';

let harness: BillingHarness;

beforeEach(() => {
  harness = createBillingHarness();
  seedPriceBook(harness);
});

afterEach(() => {
  harness.close();
});

describe('finalizeQueryBill', () => {
  it('finalizes a Taskless Query bill', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status).toBe('finalized');
    // 1000 tokens * 20 nanoCny = 20_000 nanoCny = 0.00002 CNY; x1.4 -> 28 microCoin
    expect(result.status === 'finalized' && result.bill.amountMicroCoin).toBe('28');
    expect(result.status === 'finalized' && result.bill.taskId).toBeNull();
    expect(result.status === 'finalized' && result.bill.coverage).toBe('complete');
  });

  it('distributes the finalized total across stages so lines sum to the total', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000', stage: 'planning' });
    insertObservation(harness, {
      queryId: 'q1', metric: 'output', quantity: '1000', stage: 'verification', suffix: 'output',
    });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status).toBe('finalized');
    const bill = harness.bills.findByQueryId('q1')!;
    const lines = harness.bills.listLines(bill.billId);
    const total = lines.reduce((sum, line) => sum + BigInt(line.amountMicroCoin), 0n);
    expect(total).toBe(BigInt(bill.amountMicroCoin));
    expect(lines.map(line => line.stage).sort()).toEqual(['planning', 'verification']);
  });

  it('is idempotent and immutable after finalization', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    const before = harness.bills.findByQueryId('q1')!;
    insertObservation(harness, {
      queryId: 'q1', metric: 'input', quantity: '9000', suffix: 'late',
    });
    const repeat = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:02:00.000Z',
    });
    expect(repeat.status).toBe('already_finalized');
    const after = harness.bills.findByQueryId('q1')!;
    expect(after.amountMicroCoin).toBe(before.amountMicroCoin);
    expect(after.finalizedAt).toBe(before.finalizedAt);
  });

  it('keeps unknown cost pending instead of fabricating zero', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, {
      queryId: 'q1', metric: 'request', resource: 'search', quantity: '3',
    });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status).toBe('pending_reconciliation');
    expect(result.status === 'pending_reconciliation' && result.reasons)
      .toContain('pending_cost:search:request:price_unavailable');
    expect(harness.bills.findByQueryId('q1')?.state).toBe('pending_reconciliation');
  });

  it('ignores zero-quantity cache writes without a cache-write price', () => {
    beginQuery(harness, { queryId: 'q-cache-zero' });
    insertObservation(harness, { queryId: 'q-cache-zero', metric: 'input', quantity: '1000' });
    insertObservation(harness, {
      queryId: 'q-cache-zero', metric: 'output', quantity: '500', suffix: 'output',
    });
    insertObservation(harness, {
      queryId: 'q-cache-zero',
      metric: 'cache_write',
      quantity: '0',
      countsTowardTotal: true,
      suffix: 'cache-write',
    });

    const result = harness.billService.finalizeQueryBill({
      queryId: 'q-cache-zero',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });

    expect(result.status).toBe('finalized');
    expect(result.status === 'finalized' && result.bill.amountMicroCoin).toBe('70');
  });

  it('does not charge a historical cache-write observation as an independent metric', () => {
    beginQuery(harness, { queryId: 'q-cache-legacy' });
    insertObservation(harness, { queryId: 'q-cache-legacy', metric: 'input', quantity: '1000' });
    insertObservation(harness, {
      queryId: 'q-cache-legacy', metric: 'output', quantity: '500', suffix: 'output',
    });
    insertObservation(harness, {
      queryId: 'q-cache-legacy',
      metric: 'cache_write',
      quantity: '1000',
      countsTowardTotal: true,
      suffix: 'cache-write',
    });

    const result = harness.billService.finalizeQueryBill({
      queryId: 'q-cache-legacy',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });

    expect(result.status).toBe('finalized');
    expect(result.status === 'finalized' && result.bill.amountMicroCoin).toBe('70');
  });

  it('keeps an unknown payer pending rather than charging the user', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000', payer: 'unknown' });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status).toBe('pending_reconciliation');
    expect(result.status === 'pending_reconciliation' && result.reasons)
      .toContain('pending_cost:model_tokens:input:payer_unknown');
  });

  it('repairs observations written by the legacy missing-payer default', () => {
    beginQuery(harness, {
      queryId: 'q-legacy-platform-default',
      payerPolicyVersion: 'unknown-v1',
    });
    insertObservation(harness, {
      queryId: 'q-legacy-platform-default',
      metric: 'input',
      quantity: '1000',
      payer: 'unknown',
    });

    const result = harness.billService.finalizeQueryBill({
      queryId: 'q-legacy-platform-default',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });

    expect(result.status).toBe('finalized');
  });

  it('stays in collecting while a chargeable call span is unsettled', () => {
    beginQuery(harness, { queryId: 'q1' });
    harness.metering.openSpan({
      spanId: 'span-1',
      queryId: 'q1',
      executionSegmentId: null,
      sourceId: 'planner',
      sourceScope: 'model_request',
      callId: 'call-1',
      stage: 'planning',
      reason: 'primary',
      state: 'started',
      payer: 'platform',
      startedAt: '2026-09-21T10:00:30.000Z',
      closedAt: null,
    });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status).toBe('pending_reconciliation');
    expect(result.status === 'pending_reconciliation' && result.reasons.join('; '))
      .toContain('unsettled_call:call-1:started');
  });

  it('reports no usage instead of a zero bill', () => {
    beginQuery(harness, { queryId: 'q1' });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status).toBe('pending_reconciliation');
    expect(result.status === 'pending_reconciliation' && result.reasons)
      .toContain('no_usage_observed');
  });

  it('finalizes a zero-cost Query as a legal zero bill', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, {
      queryId: 'q1', metric: 'input', quantity: '1000', payer: 'system',
    });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status).toBe('finalized');
    expect(result.status === 'finalized' && result.bill.amountMicroCoin).toBe('0');
  });

  it('excludes user-paid model cost but still charges MetaWork execution resources', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, {
      queryId: 'q1', metric: 'input', quantity: '1000', payer: 'user_direct',
    });
    insertObservation(harness, {
      queryId: 'q1', metric: 'cpu_second', resource: 'compute', unit: 'second',
      quantity: '100', payer: 'user_direct', stage: 'execution', suffix: 'cpu',
    });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    // Only 100 cpu seconds * 500 nanoCny = 50_000 nanoCny -> 70 microCoin at 40% markup.
    expect(result.status).toBe('finalized');
    expect(result.status === 'finalized' && result.bill.amountMicroCoin).toBe('70');
  });

  it('absorbs platform-defect rework instead of passing it to the user', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, {
      queryId: 'q1', metric: 'input', quantity: '1000', payer: 'platform',
    });
    const bill = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(bill.status).toBe('finalized');
    const entries = harness.costEntries.listForQuery('q1');
    expect(entries.filter(entry => entry.disposition === 'eligible')).toHaveLength(1);
  });

  it('allows finalizing with an audited platform absorption of a missing category', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    insertObservation(harness, {
      queryId: 'q1', metric: 'request', resource: 'search', quantity: '2', suffix: 'search',
    });
    const absorption = validatePlatformAbsorption({
      reason: 'provider usage endpoint unavailable',
      authorizedBy: 'ops@metawork',
      decidedAt: '2026-09-21T10:00:59.000Z',
      missingCategories: ['search:request'],
    });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
      platformAbsorption: absorption,
    });
    expect(result.status).toBe('finalized');
    if (result.status !== 'finalized') throw new Error('unreachable');
    expect(result.bill.amountMicroCoin).toBe('28');
    expect(result.bill.platformAbsorption).not.toBeNull();
  });

  it('previews in-flight accrual without pretending it is final', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    const preview = harness.billService.previewQueryUsage('q1');
    expect(preview.assessedMicroCoin).toBe('28');
    expect(preview.coverage.coverage).toBe('complete');
    // No bill was created by a preview.
    expect(harness.bills.findByQueryId('q1')).toBeNull();
  });

  it('pins the Query price book version at acceptance time', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    const bill = harness.bills.findByQueryId('q1')!;
    expect(bill.priceBookVersion).toBe(PLATFORM_PRICE_BOOK.priceBookVersion);
    expect(bill.feePolicyVersion).toBe(PLATFORM_PRICE_BOOK.feePolicyVersion);
    expect(bill.payerPolicyVersion).toBe(PLATFORM_PRICE_BOOK.payerPolicyVersion);
  });
});

describe('Task rollup', () => {
  it('sums assigned finalized Query amounts without re-charging', () => {
    beginQuery(harness, { queryId: 'q1' });
    beginQuery(harness, { queryId: 'q2' });
    beginQuery(harness, { queryId: 'q3' });
    linkTask(harness, 'q2', 'task-1');
    linkTask(harness, 'q3', 'task-1');
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    insertObservation(harness, { queryId: 'q2', metric: 'input', quantity: '2000' });
    insertObservation(harness, { queryId: 'q3', metric: 'input', quantity: '3000' });
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    harness.billService.finalizeQueryBill({ queryId: 'q2', finalizedAt: '2026-09-21T10:01:00.000Z' });
    harness.billService.finalizeQueryBill({ queryId: 'q3', finalizedAt: '2026-09-21T10:01:00.000Z' });

    const q2 = harness.bills.findByQueryId('q2')!;
    const q3 = harness.bills.findByQueryId('q3')!;
    const bills = harness.bills.listBillsForTask('task-1');
    expect(bills).toHaveLength(2);
    const total = bills.reduce((sum, bill) => sum + BigInt(bill.amountMicroCoin), 0n);
    expect(total).toBe(BigInt(q2.amountMicroCoin) + BigInt(q3.amountMicroCoin));
    // The Taskless Query is not counted into the Task rollup.
    expect(bills.map(bill => bill.queryId).sort()).toEqual(['q2', 'q3']);
  });

  it('binds a Query to at most one cost Task', () => {
    beginQuery(harness, { queryId: 'q1' });
    linkTask(harness, 'q1', 'task-1');
    linkTask(harness, 'q1', 'task-1');
    const outcome = createQueryContextService({
      store: harness.contexts,
      createQueryId: () => 'q1',
    }).bindCostTask({
      queryId: 'q1',
      taskId: 'task-2',
      decisionId: 'decision-2',
      basis: 'authorized_application',
      linkedAt: '2026-09-21T10:00:20.000Z',
    });
    expect(outcome.status).toBe('conflict');
    expect(harness.contexts.findTaskLink('q1')?.costTaskId).toBe('task-1');
  });
});
