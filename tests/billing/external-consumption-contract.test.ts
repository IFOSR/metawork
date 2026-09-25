import { describe, expect, it, vi } from 'vitest';
import {
  buildConsumptionBill,
  canonicalConsumptionPayload,
  computeBillDigest,
  nextBackoffMs,
  outboxStateForResult,
  shouldAdvanceState,
  validateConsumptionResult,
  type ConsumptionBillPayload,
} from '../../src/billing/consumption-contract.js';
import {
  createExternalConsumptionClient,
  parseConsumptionResult,
} from '../../src/integrations/external-consumption-client.js';

function payload(overrides: Partial<ConsumptionBillPayload> = {}): ConsumptionBillPayload {
  return {
    sourceSystem: 'metawork',
    sourceInstanceId: 'instance-a',
    externalAccountRef: 'acct-ext',
    billId: 'bill_1',
    queryId: 'q1',
    taskId: null,
    version: 1,
    amountMicroCoin: '1400',
    priceBookVersion: 'pb-test',
    ...overrides,
  };
}

describe('consumption bill digest', () => {
  it('is deterministic and excludes the digest itself', () => {
    const first = computeBillDigest(payload());
    const second = computeBillDigest(payload());
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
    expect(canonicalConsumptionPayload(payload())).not.toContain(first);
  });

  it('covers account, amount, unit, version and attribution fields', () => {
    const base = computeBillDigest(payload());
    expect(computeBillDigest(payload({ externalAccountRef: 'other' }))).not.toBe(base);
    expect(computeBillDigest(payload({ amountMicroCoin: '1401' }))).not.toBe(base);
    expect(computeBillDigest(payload({ version: 2 as never }))).not.toBe(base);
    expect(computeBillDigest(payload({ queryId: 'q2' }))).not.toBe(base);
    expect(computeBillDigest(payload({ taskId: 'task-1' }))).not.toBe(base);
    expect(computeBillDigest(payload({ priceBookVersion: 'pb-2' }))).not.toBe(base);
    expect(computeBillDigest(payload({ sourceInstanceId: 'instance-b' }))).not.toBe(base);
  });

  it('builds an immutable bill carrying its digest', () => {
    const bill = buildConsumptionBill(payload());
    expect(bill.digest).toBe(computeBillDigest(payload()));
    expect(Object.isFrozen(bill)).toBe(true);
  });
});

describe('validateConsumptionResult', () => {
  const expected = buildConsumptionBill(payload());

  it('accepts a matching applied result', () => {
    const validation = validateConsumptionResult({
      expected,
      result: {
        billId: 'bill_1',
        digest: expected.digest,
        state: 'applied',
        externalEntryId: 'ext-1',
        appliedAmountMicroCoin: '1400',
      },
    });
    expect(validation.ok).toBe(true);
  });

  it('rejects a different bill key or digest (wrong account scope)', () => {
    expect(validateConsumptionResult({
      expected,
      result: { billId: 'bill_2', digest: expected.digest, state: 'applied' },
    })).toEqual({ ok: false, reason: 'bill_id_mismatch:bill_2' });
    expect(validateConsumptionResult({
      expected,
      result: { billId: 'bill_1', digest: 'other', state: 'applied' },
    })).toEqual({ ok: false, reason: 'digest_mismatch' });
  });

  it('requires an external entry id and an exactly matching amount for applied', () => {
    expect(validateConsumptionResult({
      expected,
      result: { billId: 'bill_1', digest: expected.digest, state: 'applied', appliedAmountMicroCoin: '1400' },
    })).toEqual({ ok: false, reason: 'applied_without_external_entry' });
    expect(validateConsumptionResult({
      expected,
      result: {
        billId: 'bill_1',
        digest: expected.digest,
        state: 'applied',
        externalEntryId: 'ext-1',
        appliedAmountMicroCoin: '1399',
      },
    })).toEqual({ ok: false, reason: 'applied_amount_mismatch' });
  });

  it('requires a reason for an explicit business rejection', () => {
    expect(validateConsumptionResult({
      expected,
      result: { billId: 'bill_1', digest: expected.digest, state: 'rejected' },
    })).toEqual({ ok: false, reason: 'rejected_without_reason' });
  });
});

describe('outbox state transitions', () => {
  it('maps results to outbox states', () => {
    expect(outboxStateForResult('applied')).toBe('confirmed');
    expect(outboxStateForResult('received')).toBe('received');
    expect(outboxStateForResult('rejected')).toBe('rejected');
    expect(outboxStateForResult('unknown')).toBe('unknown');
  });

  it('never downgrades a confirmed bill', () => {
    expect(shouldAdvanceState('confirmed', 'unknown')).toBe(false);
    expect(shouldAdvanceState('confirmed', 'received')).toBe(false);
    expect(shouldAdvanceState('received', 'unknown')).toBe(false);
    expect(shouldAdvanceState('received', 'confirmed')).toBe(true);
    expect(shouldAdvanceState('unknown', 'received')).toBe(true);
    expect(shouldAdvanceState('rejected', 'confirmed')).toBe(true);
    expect(shouldAdvanceState('rejected', 'unknown')).toBe(false);
  });

  it('bounds the retry backoff', () => {
    expect(nextBackoffMs(1)).toBe(1_000);
    expect(nextBackoffMs(2)).toBe(2_000);
    expect(nextBackoffMs(20)).toBe(15 * 60_000);
    expect(nextBackoffMs(0)).toBe(1_000);
  });
});

describe('HTTP adapter', () => {
  const bill = buildConsumptionBill(payload());

  it('posts the normalized payload with server-held credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      billId: 'bill_1',
      digest: bill.digest,
      state: 'applied',
      externalEntryId: 'ext-1',
      appliedAmountMicroCoin: '1400',
    }), { status: 200 })) as unknown as typeof fetch;
    const client = createExternalConsumptionClient({
      baseUrl: 'https://billing.example/',
      bearerToken: 'secret-token',
      fetchImpl,
    });
    const result = await client.submitBill(bill);
    expect(result.state).toBe('applied');
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[0]).toBe('https://billing.example/consumption-bills');
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-token');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.digest).toBeUndefined();
    expect(body.amountMicroCoin).toBe('1400');
  });

  it('queries status by the stable original key', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      billId: 'bill_1',
      digest: bill.digest,
      state: 'unknown',
    }), { status: 200 })) as unknown as typeof fetch;
    const client = createExternalConsumptionClient({
      baseUrl: 'https://billing.example',
      bearerToken: 'secret-token',
      fetchImpl,
    });
    await client.getBillStatus({ sourceInstanceId: 'instance-a', billId: 'bill_1' });
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[0]).toBe('https://billing.example/consumption-bills/instance-a/bill_1');
  });

  it('rejects malformed responses and HTTP mismatches', () => {
    expect(() => parseConsumptionResult({}, true)).toThrow('invalid_consumption_result_bill_id');
    expect(() => parseConsumptionResult({ billId: 'b', digest: 'd' }, true))
      .toThrow('invalid_consumption_result_state');
    expect(() => parseConsumptionResult(
      { billId: 'b', digest: 'd', state: 'received' },
      false,
    )).toThrow('consumption_result_http_mismatch');
    expect(parseConsumptionResult(
      { billId: 'b', digest: 'd', state: 'rejected', reason: 'insufficient_funds' },
      false,
    ).state).toBe('rejected');
  });
});
