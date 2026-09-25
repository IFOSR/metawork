import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginQuery,
  createBillingHarness,
  insertObservation,
  seedPriceBook,
  type BillingHarness,
} from './harness.js';
import { createConsumptionExportService } from '../../src/billing/consumption-export-service.js';
import { createConsumptionReconciliationService } from '../../src/billing/consumption-reconciliation-service.js';
import {
  buildConsumptionBill,
  type ConsumptionBill,
  type ConsumptionResult,
  type ExternalConsumptionPort,
} from '../../src/billing/consumption-contract.js';
import { createFakeConsumptionServer } from '../../src/integrations/external-consumption-client.js';

let harness: BillingHarness;

beforeEach(() => {
  harness = createBillingHarness();
  seedPriceBook(harness);
});

afterEach(() => {
  harness.close();
});

function finalizeExportable(queryId = 'q1'): string {
  harness.bindExternalAccountRef('acct-ext');
  beginQuery(harness, { queryId });
  harness.setExportEnabled(true);
  insertObservation(harness, { queryId, metric: 'input', quantity: '1000' });
  const result = harness.billService.finalizeQueryBill({
    queryId,
    finalizedAt: '2026-09-21T10:01:00.000Z',
  });
  if (result.status !== 'finalized') throw new Error(`finalize failed: ${result.status}`);
  return result.bill.billId;
}

function exportService(
  port: ExternalConsumptionPort,
  options: { readonly exportEnabled?: boolean; readonly now?: () => string } = {},
) {
  return createConsumptionExportService({
    port,
    outbox: harness.outbox,
    exportEnabled: () => options.exportEnabled ?? true,
    now: options.now ?? (() => '2026-09-21T10:05:00.000Z'),
  });
}

describe('consumption outbox creation', () => {
  it('creates the outbox row with the final bill when export is enabled', () => {
    const billId = finalizeExportable();
    const record = harness.outbox.find(billId);
    expect(record).not.toBeNull();
    expect(record?.state).toBe('not_exported');
    expect(record?.sourceInstanceId).toBe('instance-test');
    expect(record?.amountMicroCoin).toBe('28');
    const bill = buildConsumptionBill(JSON.parse(record!.payloadJson) as Omit<ConsumptionBill, 'digest'>);
    expect(record?.payloadDigest).toBe(bill.digest);
  });

  it('does not create an outbox row while export is disabled (shadow mode)', () => {
    beginQuery(harness, { queryId: 'q1' });
    insertObservation(harness, { queryId: 'q1', metric: 'input', quantity: '1000' });
    const result = harness.billService.finalizeQueryBill({
      queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(result.status).toBe('finalized');
    if (result.status !== 'finalized') throw new Error('unreachable');
    expect(harness.outbox.find(result.bill.billId)).toBeNull();
  });
});

describe('consumption export outcomes', () => {
  it('confirms only when the external system applied the exact amount', async () => {
    const billId = finalizeExportable();
    const server = createFakeConsumptionServer();
    const outcome = await exportService(server).exportBill(billId);
    expect(outcome).toEqual({ status: 'settled', billId, state: 'confirmed' });
    expect(harness.outbox.find(billId)?.state).toBe('confirmed');
    const receipt = harness.outbox.latestReceipt(billId);
    expect(receipt?.state).toBe('applied');
    expect(receipt?.appliedAmountMicroCoin).toBe('28');
    expect(receipt?.externalEntryId).toMatch(/^ext_/);
  });

  it('treats receive-only as received, not as deducted', async () => {
    const billId = finalizeExportable();
    const server = createFakeConsumptionServer();
    server.setMode('receive_only');
    const outcome = await exportService(server).exportBill(billId);
    expect(outcome).toEqual({ status: 'settled', billId, state: 'received' });
    expect(harness.outbox.find(billId)?.state).toBe('received');
    expect(harness.outbox.latestReceipt(billId)?.appliedAmountMicroCoin).toBeNull();
  });

  it('reconciles a lost response by querying the original key', async () => {
    const billId = finalizeExportable();
    const server = createFakeConsumptionServer();
    let firstSubmit = true;
    const lossy: ExternalConsumptionPort = {
      submitBill: async (bill) => {
        const result = await server.submitBill(bill);
        if (firstSubmit) {
          firstSubmit = false;
          throw new Error('socket hang up after apply');
        }
        return result;
      },
      getBillStatus: key => server.getBillStatus(key),
    };
    const outcome = await exportService(lossy).exportBill(billId);
    expect(outcome).toEqual({ status: 'settled', billId, state: 'confirmed' });
    // The external system applied exactly one consumption for this bill.
    expect(server.applied.size).toBe(1);
    expect(harness.outbox.latestReceipt(billId)?.externalEntryId).toBe('ext_1');
  });

  it('does not submit a second consumption for an already confirmed bill', async () => {
    const billId = finalizeExportable();
    const server = createFakeConsumptionServer();
    const service = exportService(server);
    await service.exportBill(billId);
    const repeat = await service.exportBill(billId);
    expect(repeat).toEqual({ status: 'settled', billId, state: 'confirmed' });
    expect(server.applied.size).toBe(1);
  });

  it('flags a mismatched applied amount for manual review', async () => {
    const billId = finalizeExportable();
    const tampering: ExternalConsumptionPort = {
      async submitBill(bill): Promise<ConsumptionResult> {
        return {
          billId: bill.billId,
          digest: bill.digest,
          state: 'applied',
          externalEntryId: 'ext-9',
          appliedAmountMicroCoin: '1',
        };
      },
      async getBillStatus(key) {
        return { billId: key.billId, digest: 'x', state: 'unknown' };
      },
    };
    const outcome = await exportService(tampering).exportBill(billId);
    expect(outcome.status).toBe('manual_review');
    expect(harness.outbox.find(billId)?.lastError).toContain('applied_amount_mismatch');
    expect(harness.bills.findByQueryId('q1')?.state).toBe('finalized');
  });

  it('flags a result from a different account scope for manual review', async () => {
    const billId = finalizeExportable();
    const foreignAccount: ExternalConsumptionPort = {
      async submitBill(bill) {
        return {
          billId: bill.billId,
          digest: 'digest-from-another-account',
          state: 'applied',
          externalEntryId: 'ext-foreign',
          appliedAmountMicroCoin: bill.amountMicroCoin,
        };
      },
      async getBillStatus(key) {
        return { billId: key.billId, digest: 'digest-from-another-account', state: 'unknown' };
      },
    };
    const outcome = await exportService(foreignAccount).exportBill(billId);
    expect(outcome).toEqual({ status: 'manual_review', billId, reason: 'digest_mismatch' });
    expect(harness.outbox.find(billId)?.state).toBe('unknown');
  });

  it('records an explicit business rejection without retrying or rotating the key', async () => {
    const billId = finalizeExportable();
    const server = createFakeConsumptionServer();
    server.setMode('reject');
    const service = exportService(server);
    const outcome = await service.exportBill(billId);
    expect(outcome).toEqual({ status: 'rejected', billId, reason: 'insufficient_funds' });
    const record = harness.outbox.find(billId);
    expect(record?.state).toBe('rejected');
    expect(record?.nextAttemptAt).toBeNull();
    const drained = await service.drainPending(10);
    expect(drained).toEqual([]);
    expect(harness.bills.findByQueryId('q1')?.amountMicroCoin).toBe('28');
  });

  it('keeps the bill idempotency key stable across a service restart', async () => {
    const billId = finalizeExportable();
    const server = createFakeConsumptionServer();
    await exportService(server).exportBill(billId);
    // "Restart": fresh service instances over the same durable outbox.
    const restarted = createConsumptionReconciliationService({
      port: server,
      outbox: harness.outbox,
      now: () => '2026-09-21T11:00:00.000Z',
    });
    const outcomes = await restarted.reconcileOutstanding(10);
    expect(outcomes).toEqual([]);
    expect(harness.outbox.readSourceInstanceId()).toBe('instance-test');
    expect(harness.outbox.find(billId)?.sourceInstanceId).toBe('instance-test');
  });

  it('stops new submissions when export is switched off but keeps the outbox', async () => {
    const billId = finalizeExportable();
    const server = createFakeConsumptionServer();
    const outcome = await exportService(server, { exportEnabled: false }).exportBill(billId);
    expect(outcome).toEqual({ status: 'not_exported', reason: 'export_disabled' });
    expect(server.applied.size).toBe(0);
    expect(harness.outbox.find(billId)?.state).toBe('not_exported');
  });

  it('drains outstanding bills and settles each one once', async () => {
    const first = finalizeExportable('q1');
    const second = finalizeExportable('q2');
    const server = createFakeConsumptionServer();
    const outcomes = await exportService(server).drainPending(10);
    expect(outcomes.map(outcome => outcome.status)).toEqual(['settled', 'settled']);
    expect(harness.outbox.find(first)?.state).toBe('confirmed');
    expect(harness.outbox.find(second)?.state).toBe('confirmed');
    expect(server.applied.size).toBe(2);
  });
});

describe('consumption reconciliation', () => {
  it('upgrades a received-only bill after the external system applies it', async () => {
    const billId = finalizeExportable();
    const server = createFakeConsumptionServer();
    server.setMode('receive_only');
    await exportService(server).exportBill(billId);
    expect(harness.outbox.find(billId)?.state).toBe('received');
    server.setMode('apply');
    await server.submitBill(
      buildConsumptionBill(JSON.parse(harness.outbox.find(billId)!.payloadJson) as Omit<ConsumptionBill, 'digest'>),
    );
    const reconciliation = createConsumptionReconciliationService({
      port: server,
      outbox: harness.outbox,
      now: () => '2026-09-21T10:10:00.000Z',
    });
    const outcome = await reconciliation.reconcileBill(billId);
    expect(outcome).toEqual({ status: 'confirmed', billId });
    expect(harness.outbox.find(billId)?.state).toBe('confirmed');
  });

  it('ignores a stale result that would downgrade a confirmed bill', async () => {
    const billId = finalizeExportable();
    const server = createFakeConsumptionServer();
    await exportService(server).exportBill(billId);
    const stalePort: ExternalConsumptionPort = {
      submitBill: bill => server.submitBill(bill),
      async getBillStatus(key) {
        return { billId: key.billId, digest: harness.outbox.find(billId)!.payloadDigest, state: 'unknown' };
      },
    };
    const reconciliation = createConsumptionReconciliationService({
      port: stalePort,
      outbox: harness.outbox,
      now: () => '2026-09-21T10:11:00.000Z',
    });
    const outcome = await reconciliation.reconcileBill(billId);
    expect(outcome.status).toBe('unchanged');
    expect(harness.outbox.find(billId)?.state).toBe('confirmed');
  });
});
