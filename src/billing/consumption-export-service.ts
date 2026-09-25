/**
 * 外部消费提交服务（ADR-0042 §6.2）。
 *
 * 至少一次交付 + 第三方持久幂等应用：同一 `sourceInstanceId + billId` 只提交
 * 一个消费意图；超时先按原键查询，不生成新 billId。明确业务拒绝不再换键
 * 重试，也不回退 Task 状态或重新执行任务。
 */

import {
  buildConsumptionBill,
  nextBackoffMs,
  outboxStateForResult,
  shouldAdvanceState,
  validateConsumptionResult,
  type ConsumptionBill,
  type ConsumptionResult,
  type ExternalConsumptionPort,
} from './consumption-contract.js';
import type {
  ConsumptionOutboxPort,
  ConsumptionOutboxRecord,
  OutboxState,
} from './ports.js';

export interface ConsumptionExportServiceDeps {
  readonly port: ExternalConsumptionPort;
  readonly outbox: ConsumptionOutboxPort;
  /** 操作开关：关闭后不新增发送，但保留 outbox 与已有回执查询。 */
  readonly exportEnabled: () => boolean;
  readonly now?: () => string;
}

export type ExportOutcome =
  | { readonly status: 'not_exported'; readonly reason: 'export_disabled' | 'unknown_bill' }
  | { readonly status: 'settled'; readonly billId: string; readonly state: OutboxState }
  | { readonly status: 'retryable'; readonly billId: string; readonly reason: string }
  | { readonly status: 'rejected'; readonly billId: string; readonly reason: string }
  | { readonly status: 'manual_review'; readonly billId: string; readonly reason: string };

export interface ConsumptionExportService {
  exportBill(billId: string): Promise<ExportOutcome>;
  drainPending(limit: number): Promise<readonly ExportOutcome[]>;
}

export function createConsumptionExportService(
  deps: ConsumptionExportServiceDeps,
): ConsumptionExportService {
  const now = deps.now ?? (() => new Date().toISOString());

  async function settleFromResult(
    record: ConsumptionOutboxRecord,
    bill: ConsumptionBill,
    raw: ConsumptionResult,
    attemptedAt: string,
  ): Promise<ExportOutcome> {
    const validation = validateConsumptionResult({ expected: bill, result: raw });
    if (!validation.ok) {
      // 来源、键或金额不一致：进入人工核对，绝不当作已扣款。
      deps.outbox.recordAttempt({
        billId: record.billId,
        state: 'unknown',
        attemptedAt,
        nextAttemptAt: null,
        lastError: `manual_review:${validation.reason}`,
      });
      return { status: 'manual_review', billId: record.billId, reason: validation.reason };
    }
    const result = validation.result;
    const next = outboxStateForResult(result.state);
    const state = shouldAdvanceState(record.state, next) ? next : record.state;
    deps.outbox.appendReceipt({
      receiptId: `receipt_${record.billId}_${attemptedAt}`,
      billId: record.billId,
      sourceInstanceId: record.sourceInstanceId,
      digest: result.digest,
      state: result.state,
      externalEntryId: result.externalEntryId ?? null,
      appliedAmountMicroCoin: result.appliedAmountMicroCoin ?? null,
      reason: result.reason ?? null,
      observedAt: attemptedAt,
    });
    if (result.state === 'rejected') {
      // 明确业务拒绝（含资金不足）：保存原因，不循环换键提交。
      deps.outbox.recordAttempt({
        billId: record.billId,
        state: 'rejected',
        attemptedAt,
        nextAttemptAt: null,
        lastError: result.reason ?? 'rejected',
      });
      return { status: 'rejected', billId: record.billId, reason: result.reason ?? 'rejected' };
    }
    if (result.state === 'unknown') {
      deps.outbox.recordAttempt({
        billId: record.billId,
        state,
        attemptedAt,
        nextAttemptAt: new Date(
          Date.parse(attemptedAt) + nextBackoffMs(record.attemptCount + 1),
        ).toISOString(),
        lastError: 'external_unknown',
      });
      return { status: 'retryable', billId: record.billId, reason: 'external_unknown' };
    }
    if (result.state === 'received') {
      // 收到但未应用：不是已扣款，继续对账。
      deps.outbox.recordAttempt({
        billId: record.billId,
        state: 'received',
        attemptedAt,
        nextAttemptAt: new Date(
          Date.parse(attemptedAt) + nextBackoffMs(record.attemptCount + 1),
        ).toISOString(),
        lastError: null,
      });
      return { status: 'settled', billId: record.billId, state: 'received' };
    }
    deps.outbox.recordAttempt({
      billId: record.billId,
      state: 'confirmed',
      attemptedAt,
      nextAttemptAt: null,
      lastError: null,
    });
    return { status: 'settled', billId: record.billId, state: 'confirmed' };
  }

  async function reconcileUnknown(
    record: ConsumptionOutboxRecord,
    bill: ConsumptionBill,
    attemptedAt: string,
  ): Promise<ExportOutcome> {
    let result: ConsumptionResult;
    try {
      result = await deps.port.getBillStatus({
        sourceInstanceId: record.sourceInstanceId,
        billId: record.billId,
      });
    } catch (error) {
      deps.outbox.recordAttempt({
        billId: record.billId,
        state: 'unknown',
        attemptedAt,
        nextAttemptAt: new Date(
          Date.parse(attemptedAt) + nextBackoffMs(record.attemptCount + 1),
        ).toISOString(),
        lastError: error instanceof Error ? error.message : 'status_query_failed',
      });
      return { status: 'retryable', billId: record.billId, reason: 'status_query_failed' };
    }
    return settleFromResult(record, bill, result, attemptedAt);
  }

  async function exportBill(billId: string): Promise<ExportOutcome> {
    const record = deps.outbox.find(billId);
    if (!record) return { status: 'not_exported', reason: 'unknown_bill' };
    if (record.state === 'confirmed' || record.state === 'rejected') {
      return { status: 'settled', billId, state: record.state };
    }
    if (!deps.exportEnabled()) return { status: 'not_exported', reason: 'export_disabled' };
    const attemptedAt = now();
    if (!deps.outbox.claimForSubmission({ billId, attemptedAt })) {
      return { status: 'retryable', billId, reason: 'not_due' };
    }
    const claimed = deps.outbox.find(billId)!;
    const bill = payloadFor(claimed);
    let raw: ConsumptionResult;
    try {
      raw = await deps.port.submitBill(bill);
    } catch (error) {
      // 网络超时视为 unknown：先以原键查询，不生成新 billId。
      const reconciled = await reconcileUnknown(claimed, bill, attemptedAt);
      if (reconciled.status !== 'retryable') return reconciled;
      const message = error instanceof Error ? error.message : 'submit_failed';
      deps.outbox.recordAttempt({
        billId,
        state: 'unknown',
        attemptedAt,
        nextAttemptAt: new Date(
          Date.parse(attemptedAt) + nextBackoffMs(claimed.attemptCount),
        ).toISOString(),
        lastError: message,
      });
      return { status: 'retryable', billId, reason: message };
    }
    return settleFromResult(claimed, bill, raw, attemptedAt);
  }

  return {
    exportBill,

    async drainPending(limit) {
      const records = deps.outbox.listByStates(['not_exported', 'pending', 'unknown', 'received'], limit);
      const outcomes: ExportOutcome[] = [];
      for (const record of records) {
        outcomes.push(await exportBill(record.billId));
      }
      return outcomes;
    },
  };
}

function payloadFor(record: ConsumptionOutboxRecord): ConsumptionBill {
  const payload = JSON.parse(record.payloadJson) as Omit<ConsumptionBill, 'digest'>;
  return buildConsumptionBill({
    ...payload,
    amountMicroCoin: record.amountMicroCoin,
    sourceInstanceId: record.sourceInstanceId,
    externalAccountRef: record.externalAccountRef,
  });
}
