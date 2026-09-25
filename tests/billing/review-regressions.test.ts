import { afterEach, describe, expect, it } from 'vitest';
import { beginQuery, createBillingHarness, insertObservation, linkTask, seedPriceBook } from './harness.js';
import { normalizeUsageEvents } from '../../src/metering/usage-normalizer.js';
import { createConsumptionExportService } from '../../src/billing/consumption-export-service.js';
import { createPriceBookVersion } from '../../src/billing/pricing.js';
import { rational } from '../../src/billing/money.js';
import { createBillQueryService } from '../../src/billing/bill-query-service.js';

const harnesses: ReturnType<typeof createBillingHarness>[] = [];
function setup(exportEnabled = false) {
  const h = createBillingHarness({ exportEnabled, externalAccountRef: 'account-A' });
  harnesses.push(h);
  seedPriceBook(h);
  beginQuery(h, { queryId: 'q' });
  return h;
}
afterEach(() => { for (const h of harnesses.splice(0)) h.close(); });

describe('billing review regressions', () => {
  it('restores the cumulative baseline rather than the last delta', () => {
    const h = setup();
    for (const [i, value] of ['100', '150', '200'].entries()) {
      const normalized = normalizeUsageEvents({
        previousSnapshots: h.metering.listCumulativeSnapshots(['planner']),
        events: [{ sourceId: 'planner', sourceEventKey: `event-${i}`, sourceScope: 'model_request',
          callId: 'call', queryId: 'q', payer: 'platform', capturedAt: `2026-09-21T10:00:0${i}Z`,
          counters: [{ resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'cumulative', value }] }],
      });
      h.metering.insertObservations(normalized.observations.map(o => ({
        ...o, spanId: null, quantityNumerator: o.quantity.numerator, quantityDenominator: o.quantity.denominator,
      })));
    }
    expect(h.metering.listObservations('q').map(o => o.quantityNumerator)).toEqual(['100', '50', '50']);
  });

  it('refreshes the authoritative task link before finalization', () => {
    const h = setup();
    expect(h.billService.finalizeQueryBill({ queryId: 'q', finalizedAt: 't1' }).status).toBe('pending_reconciliation');
    linkTask(h, 'q', 'task-1');
    insertObservation(h, { queryId: 'q', metric: 'input', quantity: '1000' });
    h.billService.finalizeQueryBill({ queryId: 'q', finalizedAt: 't2' });
    expect(h.bills.findByQueryId('q')?.taskId).toBe('task-1');
  });

  it('pins the external account at query acceptance', () => {
    const h = setup(true);
    h.bindExternalAccountRef('account-B');
    insertObservation(h, { queryId: 'q', metric: 'input', quantity: '1000' });
    h.billService.finalizeQueryBill({ queryId: 'q', finalizedAt: 't1' });
    expect(h.outbox.find('bill_q')?.externalAccountRef).toBe('account-A');
  });

  it('keeps an unmeasured closed call pending', () => {
    const h = setup();
    h.metering.openSpan({ spanId: 'missing', queryId: 'q', executionSegmentId: null,
      sourceId: 'executor', sourceScope: 'harness_turn', callId: 'missing', stage: 'execution',
      reason: 'primary', state: 'closed', payer: 'platform', startedAt: 't1', closedAt: 't2' });
    insertObservation(h, { queryId: 'q', metric: 'input', quantity: '1000' });
    expect(h.billService.finalizeQueryBill({ queryId: 'q', finalizedAt: 't3' }).status).toBe('pending_reconciliation');
  });

  it('reports missing model categories from a closed span even without a placeholder observation', () => {
    const h = setup();
    h.metering.openSpan({
      spanId: 'closed-without-usage',
      queryId: 'q',
      executionSegmentId: null,
      sourceId: 'executor',
      sourceScope: 'harness_turn',
      callId: 'closed-without-usage',
      stage: 'execution',
      reason: 'primary',
      state: 'closed',
      payer: 'platform',
      startedAt: 't1',
      closedAt: 't2',
    });
    insertObservation(h, { queryId: 'q', metric: 'input', quantity: '1000' });
    const result = h.billService.finalizeQueryBill({ queryId: 'q', finalizedAt: 't3' });
    expect(result.status).toBe('pending_reconciliation');
    if (result.status !== 'pending_reconciliation') throw new Error('unreachable');
    expect(result.coverage.missingCategories).toContain('model_tokens:output');
  });

  it('does not require a price for a reported excluded subset', () => {
    const h = setup();
    insertObservation(h, { queryId: 'q', metric: 'output', quantity: '1000' });
    insertObservation(h, { queryId: 'q', metric: 'reasoning', quantity: '500', countsTowardTotal: false });
    expect(h.billService.finalizeQueryBill({ queryId: 'q', finalizedAt: 't1' }).status).toBe('finalized');
  });

  it('does not downgrade confirmed consumption with stale updates', () => {
    const h = setup(true);
    insertObservation(h, { queryId: 'q', metric: 'input', quantity: '1000' });
    h.billService.finalizeQueryBill({ queryId: 'q', finalizedAt: 't1' });
    h.outbox.recordAttempt({ billId: 'bill_q', state: 'confirmed', attemptedAt: 't3', nextAttemptAt: null, lastError: null });
    h.outbox.recordAttempt({ billId: 'bill_q', state: 'received', attemptedAt: 't2', nextAttemptAt: null, lastError: null });
    expect(h.outbox.find('bill_q')?.state).toBe('confirmed');
  });

  it('stops automatic submissions after an invalid receipt', async () => {
    const h = setup(true);
    insertObservation(h, { queryId: 'q', metric: 'input', quantity: '1000' });
    h.billService.finalizeQueryBill({ queryId: 'q', finalizedAt: 't1' });
    let submissions = 0;
    const exporter = createConsumptionExportService({ outbox: h.outbox, exportEnabled: () => true,
      port: { submitBill: async bill => { submissions++; return { billId: bill.billId, digest: 'wrong', state: 'received' }; },
        getBillStatus: async () => { throw new Error('unexpected status query'); } } });
    expect((await exporter.exportBill('bill_q')).status).toBe('manual_review');
    await exporter.drainPending(10);
    expect(submissions).toBe(1);
  });

  it('persists and uses a foreign currency price book', () => {
    const h = setup();
    h.prices.insert(createPriceBookVersion({ priceBookVersion: 'usd', feePolicyVersion: 'fp-test', markupBps: 4000n,
      effectiveFrom: 't1', exchangeRate: { sourceCurrency: 'USD', nanoCnyPerSourceUnit: rational(7_000_000_000n), effectiveFrom: 't1' },
      units: [{ resource: 'model_tokens', metric: 'input', sourceCurrency: 'USD', nanoCnyPerUnit: rational(1n, 1_000_000n) }] }), 't1');
    beginQuery(h, { queryId: 'usd-query', priceBookVersion: 'usd' });
    insertObservation(h, { queryId: 'usd-query', metric: 'input', quantity: '1000' });
    h.billService.finalizeQueryBill({ queryId: 'usd-query', finalizedAt: 't2' });
    expect(h.bills.findByQueryId('usd-query')?.amountMicroCoin).toBe('9800');
  });

  it('aggregates every account bill independently of list pagination', () => {
    const h = setup();
    for (let i = 0; i < 501; i++) {
      beginQuery(h, { queryId: `q${i}` });
      insertObservation(h, { queryId: `q${i}`, metric: 'input', quantity: '1000' });
      h.billService.finalizeQueryBill({ queryId: `q${i}`, finalizedAt: 't1' });
    }
    const service = createBillQueryService({ bills: h.bills, adjustments: h.adjustments, consumption: h.outbox });
    expect(service.getUsageSummary('account-1').finalizedMicroCoin).toBe('14028');
  });
});
