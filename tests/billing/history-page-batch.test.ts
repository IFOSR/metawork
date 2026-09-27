import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerBillingServices } from '../../src/server/billing-composition.js';
import type { QueryBillRecord } from '../../src/billing/ports.js';
import {
  createBillingHarness, insertObservation, linkTask, PLATFORM_PRICE_BOOK,
  seedPriceBook, type BillingHarness,
} from './harness.js';

let h: BillingHarness;
const at = '2026-09-26T00:00:00.000Z';

beforeEach(() => {
  h = createBillingHarness({ exportEnabled: true, externalAccountRef: 'external' });
  seedPriceBook(h);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  h.close();
});

function seed(id: string, options: {
  accountId?: string; turnId?: string; taskId?: string;
  state?: QueryBillRecord['state'] | 'missing';
  payer?: 'platform' | 'system'; price?: string; noUsage?: boolean;
} = {}) {
  h.contexts.insert({
    queryId: id, accountId: options.accountId ?? 'account-1', ingress: 'web',
    externalAccountRef: 'external',
    requestKey: id, requestPayloadDigest: id, conversationId: 'conversation',
    requestId: id, turnId: options.turnId ?? id, executionSegmentId: null,
    ...PLATFORM_PRICE_BOOK, priceBookVersion: options.price ?? 'pb-test', acceptedAt: at,
  });
  if (options.taskId) linkTask(h, id, options.taskId);
  if (!options.noUsage) {
    insertObservation(h, {
      queryId: id, metric: 'input', quantity: '1000', payer: options.payer,
    });
  }
  if (options.state === 'missing') return;
  h.billService.finalizeQueryBill({ queryId: id, finalizedAt: at });
  if (options.state === 'collecting') {
    h.db.prepare("UPDATE query_bills SET state = 'collecting' WHERE query_id = ?").run(id);
  }
}

function service() {
  return createServerBillingServices(h.db, {}, {}).queries;
}

function countReads(onRows?: (rows: unknown) => void) {
  let reads = 0;
  const prepare = h.db.prepare.bind(h.db);
  vi.spyOn(h.db, 'prepare').mockImplementation((sql: string) => {
    const stmt = prepare(sql);
    for (const method of ['all', 'get', 'iterate'] as const) {
      const original = stmt[method].bind(stmt);
      vi.spyOn(stmt, method).mockImplementation((...args: unknown[]) => {
        reads++;
        const result = original(...args);
        onRows?.(result);
        return result;
      });
    }
    return stmt;
  });
  return () => reads;
}

describe('physical billing history batches', () => {
  it('uses a constant number of real SQL reads for 1 versus 10 turns, then no SQL', () => {
    for (let i = 0; i < 10; i++) seed(`q${i}`, { taskId: `task${i}` });
    const queries = service();
    expect(queries.forHistoryPage).toBeTypeOf('function');
    h.db.pragma('query_only = ON');
    const reads = countReads();
    const counts: number[] = [];
    for (const size of [1, 10]) {
      const turns = Array.from({ length: size }, (_, i) => `q${i}`);
      const tasks = Array.from({ length: size }, (_, i) => `task${i}`);
      const before = reads();
      const page = queries.forHistoryPage!('account-1', turns, tasks);
      const prefetched = reads();
      counts.push(prefetched - before);
      for (const turn of turns) {
        expect(page.getTurnBillUserView('account-1', turn)?.userStatus).toBe('billed');
        expect(page.getQueryBillForTurn('account-1', turn)?.lines.length).toBeGreaterThan(0);
      }
      for (const task of tasks) {
        expect(page.getTaskUsageSummaryForAccount('account-1', task)?.queryCount).toBe(1);
      }
      expect(reads()).toBe(prefetched);
    }
    expect(counts).toEqual([12, 12]);
  });

  it('reuses canonical projections for billed, zero, collecting, pending and missing facts', () => {
    seed('billed', { taskId: 'task' });
    seed('zero', { payer: 'system' });
    seed('collecting', { state: 'collecting' });
    seed('pending', { noUsage: true });
    seed('missing-price', { price: 'unconfigured' });
    seed('no-bill', { state: 'missing', taskId: 'task' });
    h.metering.openSpan({
      spanId: 'span', queryId: 'pending', executionSegmentId: null, sourceId: 'executor',
      sourceScope: 'model_request', callId: 'call', stage: 'execution', reason: 'primary',
      state: 'closed', payer: 'platform', startedAt: at, closedAt: at,
    });
    const bill = h.bills.findByQueryId('billed')!;
    h.adjustments.insert({
      adjustmentId: 'adjust', billId: bill.billId, reason: 'correction', amountMicroCoin: '-1',
      authorizedBy: 'operator', notes: '', externalState: 'not_exported',
      externalReference: null, createdAt: at,
    });
    const queries = service();
    const ids = ['billed', 'zero', 'collecting', 'pending', 'missing-price', 'no-bill', 'ancient'];
    const expected = ids.map(id => queries.getTurnBillUserView('account-1', id));
    const expectedBills = ids.map(id => queries.getQueryBillForTurn('account-1', id));
    h.db.pragma('query_only = ON');
    const page = queries.forHistoryPage!('account-1', ids, ['task']);
    const reads = countReads();
    expect(ids.map(id => page.getTurnBillUserView('account-1', id))).toEqual(expected);
    expect(ids.map(id => page.getQueryBillForTurn('account-1', id))).toEqual(expectedBills);
    expect(page.getTurnBillUserView('account-1', 'ancient', { liveFallback: true })?.diagnosticCode)
      .toBe('query_not_finalized');
    expect(reads()).toBe(0);
  });

  it('includes off-page task bills and preserves receipt precedence and tie ordering', () => {
    seed('q1', { taskId: 'task' });
    seed('q2', { taskId: 'task' });
    const bill = h.bills.findByQueryId('q2')!;
    for (const [id, state, time] of [
      ['a', 'applied', at], ['b', 'applied', at],
      ['c', 'rejected', '2026-09-27T00:00:00.000Z'],
    ] as const) {
      h.outbox.appendReceipt({
        receiptId: id, billId: bill.billId, sourceInstanceId: 'instance-test', digest: 'digest',
        state, externalEntryId: id, appliedAmountMicroCoin: state === 'applied' ? '28' : null,
        reason: null, observedAt: time,
      });
    }
    const queries = service();
    const expected = queries.listQueryBillsForTask('account-1', 'task');
    const summary = queries.getTaskUsageSummaryForAccount('account-1', 'task');
    const page = queries.forHistoryPage!('account-1', ['q1'], ['task']);
    const reads = countReads();
    expect(page.listQueryBillsForTask('account-1', 'task')).toEqual(expected);
    expect(page.getTaskUsageSummaryForAccount('account-1', 'task')).toEqual(summary);
    expect(summary).toMatchObject({ queryCount: 2, confirmedDeductedMicroCoin: '28' });
    expect(expected.find(row => row.queryId === 'q2')?.externalEntryId).toBe('b');
    expect(reads()).toBe(0);
  });

  it('selects the latest account-scoped context and fails closed on mixed-account tasks', () => {
    seed('old', { turnId: 'turn' });
    seed('z-new', { turnId: 'turn', taskId: 'mixed' });
    seed('foreign', { accountId: 'account-2', turnId: 'turn', taskId: 'mixed' });
    seed('private', { accountId: 'account-2', taskId: 'private-task' });
    const queries = service();
    const page = queries.forHistoryPage!('account-1', ['turn', 'private'], ['mixed', 'private-task', 'empty']);
    expect(page.getQueryBillForTurn('account-1', 'turn')?.queryId).toBe('z-new');
    expect(page.getQueryBillForTurn('account-1', 'private')).toBeNull();
    expect(page.getQueryBillForAccount('account-1', 'foreign')).toBeNull();
    for (const task of ['mixed', 'private-task', 'empty']) {
      expect(page.getTaskUsageSummaryForAccount('account-1', task)).toBeNull();
    }
    expect(page.listQueryBillsForTask('account-1', 'mixed'))
      .toEqual(queries.listQueryBillsForTask('account-1', 'mixed'));
  });

  it('retains an isolated read snapshot when new usage and receipts arrive', () => {
    seed('q1', { state: 'missing' });
    const queries = service();
    const page = queries.forHistoryPage!('account-1', ['q1'], []);
    const before = page.getTurnBillUserView('account-1', 'q1');
    insertObservation(h, { queryId: 'q1', metric: 'output', quantity: '200' });
    h.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: at });
    expect(page.getTurnBillUserView('account-1', 'q1')).toEqual(before);
    expect(queries.getTurnBillUserView('account-1', 'q1')?.userStatus).toBe('billed');
  });

  it('does not read unrelated account facts and supports empty or missing-only pages', () => {
    seed('unrelated');
    seed('visible');
    const queries = service();
    h.db.pragma('query_only = ON');
    const returned: string[] = [];
    const reads = countReads(rows => returned.push(JSON.stringify(rows)));
    const page = queries.forHistoryPage!('account-1', ['visible'], []);
    expect(page.getQueryBillForTurn('account-1', 'visible')?.queryId).toBe('visible');
    expect(returned.join('\n')).not.toContain('unrelated');
    expect(reads()).toBe(12);
    expect(queries.forHistoryPage!('account-1', [], [])).toBeDefined();
    const missing = queries.forHistoryPage!('account-1', ['missing'], ['missing-task']);
    expect(missing.getTurnBillUserView('account-1', 'missing')?.diagnosticCode)
      .toBe('historical_unavailable');
    expect(missing.getTaskUsageSummaryForAccount('account-1', 'missing-task')).toBeNull();
  });

  it('retains a mismatching bill account as a denial, not a no-bill fallback', () => {
    seed('mismatch');
    h.db.prepare("UPDATE query_bills SET account_id = 'account-2' WHERE query_id = 'mismatch'").run();
    const queries = service();
    const page = queries.forHistoryPage!('account-1', ['mismatch'], []);
    expect(queries.getTurnBillUserView('account-1', 'mismatch')).toBeNull();
    expect(page.getTurnBillUserView('account-1', 'mismatch')).toBeNull();
    expect(page.getQueryBillForTurn('account-1', 'mismatch')).toBeNull();
  });

  it('rejects out-of-scope reads instead of silently returning partial account totals', () => {
    seed('q1');
    const queries = service();
    const page = queries.forHistoryPage!('account-1', ['q1'], []);
    expect(() => page.getUsageSummary('account-1')).toThrow('billing_history_scope');
    expect(() => page.listQueryBills({ accountId: 'account-1', limit: 10 })).toThrow('billing_history_scope');
    expect(() => page.getTurnBillUserView('account-1', 'not-requested')).toThrow('billing_history_scope');
    expect(() => page.getTaskUsageSummaryForAccount('account-1', 'not-requested')).toThrow('billing_history_scope');
    expect(() => page.getQueryBillForTurn('account-2', 'q1')).toThrow('billing_history_scope');
    expect(() => queries.forHistoryPage!('account-1', Array(101).fill('q1'), []))
      .toThrow('history_turn_limit');
  });
});
