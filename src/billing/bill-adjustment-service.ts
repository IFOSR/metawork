/**
 * 账单调整服务（ADR-0042 §5.3）。
 *
 * 最终单不可变。迟到的实际采购成本只用于内部对账与利润分析，不自动追加
 * 扣款；需要纠错时建立引用原单的 adjustment，由独立外部流程处理。
 */

import { nanoid } from 'nanoid';
import type { BillAdjustmentPort, BillAdjustmentRecord, BillStorePort } from './ports.js';

export interface BillAdjustmentServiceDeps {
  readonly bills: BillStorePort;
  readonly adjustments: BillAdjustmentPort;
  readonly createAdjustmentId?: () => string;
}

export interface RecordAdjustmentInput {
  readonly billId: string;
  readonly amountMicroCoin: string;
  readonly reason: string;
  readonly authorizedBy: string;
  readonly notes?: string;
  readonly createdAt: string;
}

export interface BillAdjustmentService {
  record(input: RecordAdjustmentInput): BillAdjustmentRecord;
  list(billId: string): readonly BillAdjustmentRecord[];
}

export function createBillAdjustmentService(
  deps: BillAdjustmentServiceDeps,
): BillAdjustmentService {
  const createId = deps.createAdjustmentId ?? (() => `adjustment_${nanoid(12)}`);
  return {
    record(input) {
      const resolved = deps.bills.findByBillId(input.billId);
      if (!resolved) throw new Error(`unknown_bill:${input.billId}`);
      if (resolved.state !== 'finalized') {
        throw new Error('adjustment_requires_finalized_bill');
      }
      if (!/^-?\d+$/u.test(input.amountMicroCoin)) throw new Error('invalid_adjustment_amount');
      if (input.reason.trim().length === 0) throw new Error('invalid_adjustment_reason');
      if (input.authorizedBy.trim().length === 0) throw new Error('invalid_adjustment_authorizer');
      const adjustment: BillAdjustmentRecord = {
        adjustmentId: createId(),
        billId: input.billId,
        reason: input.reason,
        amountMicroCoin: input.amountMicroCoin,
        authorizedBy: input.authorizedBy,
        notes: input.notes ?? '',
        externalState: 'not_exported',
        externalReference: null,
        createdAt: input.createdAt,
      };
      deps.adjustments.insert(adjustment);
      return adjustment;
    },

    list(billId) {
      return deps.adjustments.listForBill(billId);
    },
  };
}
