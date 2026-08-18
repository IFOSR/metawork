import { describe, expect, it } from 'vitest';
import { IdempotentCommandAdmission } from '../../src/gateway/command-admission.js';

describe('IdempotentCommandAdmission', () => {
  it('returns the original receipt for a duplicate idempotency key', async () => {
    let submits = 0;
    const admission = new IdempotentCommandAdmission({
      submit: async (conversationId, requestId, idempotencyKey) => {
        submits += 1;
        return { requestId, idempotencyKey, status: 'accepted' as const };
      },
    });

    const first = await admission.admit('req_1', 'idem_1', 'conv_1');
    const duplicate = await admission.admit('req_2', 'idem_1', 'conv_1');

    expect(first.status).toBe('accepted');
    expect(duplicate.status).toBe('duplicate');
    expect(submits).toBe(1);
  });

  it('propagates a rejected mailbox receipt', async () => {
    const admission = new IdempotentCommandAdmission({
      submit: async () => ({ requestId: 'req_1', idempotencyKey: 'idem_1', status: 'rejected' as const, reason: 'busy' }),
    });

    const receipt = await admission.admit('req_1', 'idem_1', 'conv_1');
    expect(receipt.status).toBe('rejected');
    expect(receipt.reason).toBe('busy');
  });
});
