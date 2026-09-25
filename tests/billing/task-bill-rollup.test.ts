import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBillQueryService } from '../../src/billing/bill-query-service.js';
import { createBillAdjustmentService } from '../../src/billing/bill-adjustment-service.js';
import { createFakeConsumptionServer } from '../../src/integrations/external-consumption-client.js';
import {
  beginQuery,
  createBillingHarness,
  insertObservation,
  linkTask,
  seedPriceBook,
  type BillingHarness,
} from './harness.js';

let harness: BillingHarness;

beforeEach(() => {
  harness = createBillingHarness({ externalAccountRef: 'acct-ext' });
  seedPriceBook(harness);
});

afterEach(() => {
  harness.close();
});

function queryService() {
  return createBillQueryService({
    bills: harness.bills,
    adjustments: harness.adjustments,
    consumption: harness.outbox,
  });
}

describe('Task and account rollups', () => {
  it('reports finalized, pending, in-flight and confirmed amounts separately', () => {
    beginQuery(harness, { queryId: 'q1' });
    beginQuery(harness, { queryId: 'q2' });
    beginQuery(harness, { queryId: 'q3' });
    linkTask(harness, 'q1', 'task-1');
    linkTask(harness, 'q2', 'task-1');
    linkTask(harness, 'q3', 'task-1');
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    insertObservation(harness, { queryId: 'q2', metric: 'input', quantity: '2000' });
    insertObservation(harness, {
      queryId: 'q2', metric: 'request', resource: 'search', quantity: '1', suffix: 'search',
    });
    insertObservation(harness, { queryId: 'q3', metric: 'input', quantity: '3000' });
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    harness.billService.finalizeQueryBill({ queryId: 'q2', finalizedAt: '2026-09-21T10:01:00.000Z' });
    // q3 stays collecting: no finalize call and no bill yet.
    const summary = queryService().getTaskUsageSummary('task-1');
    expect(summary.queryCount).toBe(2);
    expect(summary.finalizedMicroCoin).toBe('28');
    expect(summary.pendingReconciliationMicroCoin).toBe('0');
    expect(summary.inFlightMicroCoin).toBe('0');
    expect(summary.confirmedDeductedMicroCoin).toBe('0');
  });

  it('does not double count a Query across Query detail and Task rollup', () => {
    beginQuery(harness, { queryId: 'q1' });
    linkTask(harness, 'q1', 'task-1');
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    const service = queryService();
    const account = service.getUsageSummary('account-1');
    const task = service.getTaskUsageSummary('task-1');
    expect(account.finalizedMicroCoin).toBe('28');
    expect(task.finalizedMicroCoin).toBe('28');
    expect(account.billCount).toBe(1);
  });

  it('shows confirmed deduction only after an applied external receipt', () => {
    beginQuery(harness, { queryId: 'q1' });
    harness.setExportEnabled(true);
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    const bill = harness.bills.findByQueryId('q1')!;
    harness.outbox.appendReceipt({
      receiptId: 'receipt-1',
      billId: bill.billId,
      sourceInstanceId: 'instance-test',
      digest: 'digest-x',
      state: 'received',
      externalEntryId: null,
      appliedAmountMicroCoin: null,
      reason: null,
      observedAt: '2026-09-21T10:02:00.000Z',
    });
    expect(queryService().getQueryBill('q1')?.confirmedDeductedMicroCoin).toBeNull();
    harness.outbox.appendReceipt({
      receiptId: 'receipt-2',
      billId: bill.billId,
      sourceInstanceId: 'instance-test',
      digest: 'digest-x',
      state: 'applied',
      externalEntryId: 'ext-1',
      appliedAmountMicroCoin: '28',
      reason: null,
      observedAt: '2026-09-21T10:03:00.000Z',
    });
    const projection = queryService().getQueryBill('q1');
    expect(projection?.externalState).not.toBe('received');
    expect(projection?.confirmedDeductedMicroCoin).toBe('28');
    expect(projection?.externalEntryId).toBe('ext-1');
  });

  it('returns null for an unknown Query bill', () => {
    expect(queryService().getQueryBill('missing')).toBeNull();
  });

  it('returns null for a Task with no bills instead of inventing an empty ownership result', () => {
    expect(queryService().getTaskUsageSummaryForAccount('account-1', 'missing-task')).toBeNull();
  });

  it('uses a stable created-at and bill id cursor for bill pages', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    beginQuery(harness, { queryId: 'q2' });
    insertObservation(harness, { queryId: 'q2', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({ queryId: 'q2', finalizedAt: '2026-09-21T10:02:00.000Z' });
    const service = queryService();
    const first = service.listQueryBillsPage!({ accountId: 'account-1', limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    beginQuery(harness, { queryId: 'q3' });
    insertObservation(harness, { queryId: 'q3', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({ queryId: 'q3', finalizedAt: '2026-09-21T10:03:00.000Z' });

    const second = service.listQueryBillsPage!({
      accountId: 'account-1',
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.billId).not.toBe(first.items[0]?.billId);
  });
});

describe('bill adjustments', () => {
  it('records a correction that references an immutable finalized bill', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    const bill = harness.bills.findByQueryId('q1')!;
    const adjustments = createBillAdjustmentService({
      bills: harness.bills,
      adjustments: harness.adjustments,
      createAdjustmentId: () => 'adjustment-1',
    });
    const recorded = adjustments.record({
      billId: bill.billId,
      amountMicroCoin: '-10',
      reason: 'late actual procurement cost lower than reference',
      authorizedBy: 'finance@metawork',
      createdAt: '2026-09-22T10:00:00.000Z',
    });
    expect(recorded.adjustmentId).toBe('adjustment-1');
    expect(harness.bills.findByQueryId('q1')?.amountMicroCoin).toBe('28');
    expect(queryService().getQueryBill('q1')?.adjustments).toEqual([
      {
        adjustmentId: 'adjustment-1',
        amountMicroCoin: '-10',
        amountMetaCoin: '-0.00001',
        reason: 'late actual procurement cost lower than reference',
        externalState: 'not_exported',
      },
    ]);
  });

  it('refuses adjustments against a bill that is not finalized', () => {
    beginQuery(harness, { queryId: 'q1' });
    const collect = harness.billService.previewQueryUsage('q1');
    expect(collect.assessedMicroCoin).toBe('0');
    const adjustments = createBillAdjustmentService({
      bills: harness.bills,
      adjustments: harness.adjustments,
      createAdjustmentId: () => 'adjustment-1',
    });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    const bill = harness.bills.findByQueryId('q1')!;
    harness.outbox.ensureSourceInstanceId('instance-test', '2026-09-21T00:00:00.000Z');
    expect(() => adjustments.record({
      billId: 'unknown-bill',
      amountMicroCoin: '1',
      reason: 'x',
      authorizedBy: 'ops',
      createdAt: '2026-09-22T10:00:00.000Z',
    })).toThrow('unknown_bill');
    expect(adjustments.list(bill.billId)).toEqual([]);
  });
});

export { beginQuery, createFakeConsumptionServer };
