import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginQuery,
  createBillingHarness,
  insertObservation,
  seedPriceBook,
  type BillingHarness,
} from './harness.js';
import { createConsumptionExportService } from '../../src/billing/consumption-export-service.js';
import { validateConsumptionResult } from '../../src/billing/consumption-contract.js';
import { createFakeConsumptionServer } from '../../src/integrations/external-consumption-client.js';
import { validatePlatformAbsorption } from '../../src/billing/cost-policy.js';

let harness: BillingHarness;

beforeEach(() => {
  harness = createBillingHarness();
  seedPriceBook(harness);
});

afterEach(() => {
  harness.close();
});

describe('bill finality', () => {
  it('separates local bill finality from external deduction state', () => {
    harness.bindExternalAccountRef('acct-ext');
    beginQuery(harness, { queryId: 'q1' });
    harness.setExportEnabled(true);
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status).toBe('finalized');
    const bill = harness.bills.findByQueryId('q1')!;
    expect(bill.state).toBe('finalized');
    expect(harness.outbox.find(bill.billId)?.state).toBe('not_exported');
    expect(harness.outbox.latestReceipt(bill.billId)).toBeNull();
  });

  it('keeps a zero-amount final bill local without requesting a deduction', () => {
    beginQuery(harness, { queryId: 'q1' });
    harness.setExportEnabled(true);
    harness.bindExternalAccountRef('acct-ext');
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000', payer: 'system' });
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    const bill = harness.bills.findByQueryId('q1')!;
    expect(bill.amountMicroCoin).toBe('0');
    expect(harness.outbox.find(bill.billId)).toBeNull();
  });

  it('deduplicates replayed observations by source event key', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    expect(harness.metering.listObservations('q1')).toHaveLength(1);
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status === 'finalized' && result.bill.amountMicroCoin).toBe('28');
  });

  it('preserves exact large amounts as decimal text', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, {
      queryId: 'q1', metric: 'input', quantity: '1000000000000000000000000',
    });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status).toBe('finalized');
    if (result.status !== 'finalized') throw new Error('unreachable');
    const amount = BigInt(result.bill.amountMicroCoin);
    // base = 1e24 tokens * 20 nanoCny = 2e25 nanoCny = 2e22 microCoin; x1.4
    expect(amount).toBe((2n * 10n ** 25n * 14_000n) / 10_000n / 1_000n);
    expect(amount.toString()).toBe('28000000000000000000000');
    expect(result.bill.billableBaseNanoCny.denominator).toBe('1');
  });

  it('refuses to finalize an unknown Query instead of inventing a bill', () => {
    expect(() => harness.billService.finalizeQueryBill({
      queryId: 'missing',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    })).toThrow('unknown_query_context');
  });

  it('keeps an unmeasured category pending instead of charging a guess', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    insertObservation(harness, {
      queryId: 'q1',
      metric: 'output',
      quantity: '0',
      quality: 'unavailable',
      countsTowardTotal: false,
      suffix: 'output-missing',
    });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status).toBe('pending_reconciliation');
    if (result.status !== 'pending_reconciliation') throw new Error('unreachable');
    expect(result.reasons).toContain('pending_cost:model_tokens:output:usage_unavailable');
    expect(result.coverage.coverage).toBe('incomplete');
  });

  it('finalizes incomplete coverage only with an audited platform absorption', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    insertObservation(harness, {
      queryId: 'q1',
      metric: 'output',
      quantity: '0',
      quality: 'unavailable',
      countsTowardTotal: false,
      suffix: 'output-missing',
    });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1',
      finalizedAt: '2026-09-21T10:01:00.000Z',
      platformAbsorption: validatePlatformAbsorption({
        reason: 'executor usage stream truncated',
        authorizedBy: 'ops@metawork',
        decidedAt: '2026-09-21T10:00:59.000Z',
        missingCategories: ['model_tokens:output'],
      }),
    });
    expect(result.status).toBe('finalized');
    if (result.status !== 'finalized') throw new Error('unreachable');
    expect(result.bill.coverage).toBe('incomplete');
    expect(result.bill.coverageNote).toContain('no trusted measurement');
    expect(result.bill.amountMicroCoin).toBe('28');
  });

  it('does not let an external rejection roll back a finalized bill', async () => {
    harness.bindExternalAccountRef('acct-ext');
    beginQuery(harness, { queryId: 'q1' });
    harness.setExportEnabled(true);
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    const bill = harness.bills.findByQueryId('q1')!;
    const server = createFakeConsumptionServer();
    server.setMode('reject');
    const exportService = createConsumptionExportService({
      port: server, outbox: harness.outbox, exportEnabled: () => true,
      now: () => '2026-09-21T10:05:00.000Z',
    });
    const outcome = await exportService.exportBill(bill.billId);
    expect(outcome.status).toBe('rejected');
    expect(harness.bills.findByQueryId('q1')?.state).toBe('finalized');
    expect(harness.bills.findByQueryId('q1')?.amountMicroCoin).toBe('28');
  });

  it('never re-prices an existing bill from a newer price book', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z' });
    const first = harness.bills.findByQueryId('q1')!;
    seedPriceBook(harness, [
      { resource: 'model_tokens', metric: 'input', nanoCnyPerUnit: { numerator: '9999', denominator: '1' } },
    ], 'pb-test-2');
    harness.billService.finalizeQueryBill({ queryId: 'q1', finalizedAt: '2026-09-22T10:01:00.000Z' });
    expect(harness.bills.findByQueryId('q1')?.amountMicroCoin).toBe(first.amountMicroCoin);
  });

  it('never downgrades a confirmed receipt during validation', () => {
    const validation = validateConsumptionResult({
      expected: {
        sourceSystem: 'metawork',
        sourceInstanceId: 'instance-test',
        externalAccountRef: 'acct-ext',
        billId: 'bill_1',
        queryId: 'q1',
        taskId: null,
        version: 1,
        amountMicroCoin: '28',
        priceBookVersion: 'pb-test',
        digest: 'digest-a',
      },
      result: { billId: 'bill_1', digest: 'digest-a', state: 'received' },
    });
    expect(validation.ok).toBe(true);
  });
});
