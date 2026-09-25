/**
 * 外部消费对账服务（ADR-0042 §6.2）。
 *
 * 本期默认通过主动查询完成对账，不要求第三方 webhook。回执与重放幂等；
 * 乱序旧结果不得把 `confirmed` 降回 `unknown`；金额不一致进入人工核对。
 */

import {
  buildConsumptionBill,
  outboxStateForResult,
  shouldAdvanceState,
  validateConsumptionResult,
  type ConsumptionBill,
  type ExternalConsumptionPort,
} from './consumption-contract.js';
import type { ConsumptionOutboxPort } from './ports.js';

export interface ConsumptionReconciliationServiceDeps {
  readonly port: ExternalConsumptionPort;
  readonly outbox: ConsumptionOutboxPort;
  readonly now?: () => string;
}

export interface ReconciliationOutcome {
  readonly status:
    | 'confirmed'
    | 'received'
    | 'rejected'
    | 'unchanged'
    | 'manual_review';
  readonly billId: string;
  readonly reason?: string;
}

export interface ConsumptionReconciliationService {
  reconcileBill(billId: string): Promise<ReconciliationOutcome>;
  reconcileOutstanding(limit: number): Promise<readonly ReconciliationOutcome[]>;
}

const OUTSTANDING_STATES = ['pending', 'received', 'unknown'] as const;

export function createConsumptionReconciliationService(
  deps: ConsumptionReconciliationServiceDeps,
): ConsumptionReconciliationService {
  const now = deps.now ?? (() => new Date().toISOString());

  async function reconcileBill(billId: string): Promise<ReconciliationOutcome> {
    const record = deps.outbox.find(billId);
    if (!record) return { status: 'unchanged', billId, reason: 'unknown_bill' };
    if (record.state === 'confirmed' || record.state === 'rejected') {
      return { status: 'unchanged', billId, reason: 'terminal' };
    }
    const bill = payloadFor(record);
    const observedAt = now();
    let raw;
    try {
      raw = await deps.port.getBillStatus({
        sourceInstanceId: record.sourceInstanceId,
        billId: record.billId,
      });
    } catch (error) {
      return {
        status: 'unchanged',
        billId,
        reason: error instanceof Error ? error.message : 'status_query_failed',
      };
    }
    const validation = validateConsumptionResult({ expected: bill, result: raw });
    if (!validation.ok) {
      deps.outbox.recordAttempt({
        billId,
        state: record.state,
        attemptedAt: observedAt,
        nextAttemptAt: null,
        lastError: `manual_review:${validation.reason}`,
      });
      return { status: 'manual_review', billId, reason: validation.reason };
    }
    const result = validation.result;
    const next = outboxStateForResult(result.state);
    deps.outbox.appendReceipt({
      receiptId: `receipt_${billId}_${observedAt}`,
      billId,
      sourceInstanceId: record.sourceInstanceId,
      digest: result.digest,
      state: result.state,
      externalEntryId: result.externalEntryId ?? null,
      appliedAmountMicroCoin: result.appliedAmountMicroCoin ?? null,
      reason: result.reason ?? null,
      observedAt,
    });
    if (!shouldAdvanceState(record.state, next)) {
      return { status: 'unchanged', billId, reason: 'stale_result_ignored' };
    }
    deps.outbox.recordAttempt({
      billId,
      state: next,
      attemptedAt: observedAt,
      nextAttemptAt: null,
      lastError: result.state === 'rejected' ? result.reason ?? 'rejected' : null,
    });
    switch (result.state) {
      case 'applied':
        return { status: 'confirmed', billId };
      case 'received':
        return { status: 'received', billId };
      case 'rejected':
        return { status: 'rejected', billId, reason: result.reason ?? 'rejected' };
      default:
        return { status: 'unchanged', billId, reason: 'still_unknown' };
    }
  }

  return {
    reconcileBill,

    async reconcileOutstanding(limit) {
      const records = deps.outbox.listByStates([...OUTSTANDING_STATES], limit);
      const outcomes: ReconciliationOutcome[] = [];
      for (const record of records) {
        outcomes.push(await reconcileBill(record.billId));
      }
      return outcomes;
    },
  };
}

function payloadFor(record: {
  billId: string;
  sourceInstanceId: string;
  externalAccountRef: string;
  payloadJson: string;
  amountMicroCoin: string;
}): ConsumptionBill {
  const payload = JSON.parse(record.payloadJson) as Omit<ConsumptionBill, 'digest'>;
  return buildConsumptionBill({
    ...payload,
    amountMicroCoin: record.amountMicroCoin,
    sourceInstanceId: record.sourceInstanceId,
    externalAccountRef: record.externalAccountRef,
  });
}
