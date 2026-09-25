/**
 * 外部消费领域契约（ADR-0042 §6.1、§6.2）。
 *
 * 这是 MetaWork 的领域端口，不假设第三方已具备同名 HTTP API。第三方系统
 * 持有资金并执行实际扣款；`received` 只表示接收，不等于已扣款。
 */

import { createHash } from 'node:crypto';
import type { OutboxState } from './ports.js';

export const CONSUMPTION_BILL_VERSION = 1;

export interface ConsumptionBill {
  readonly sourceSystem: 'metawork';
  readonly sourceInstanceId: string;
  readonly externalAccountRef: string;
  readonly billId: string;
  readonly queryId: string;
  readonly taskId: string | null;
  readonly version: typeof CONSUMPTION_BILL_VERSION;
  /** microCoin 十进制字符串；跨进程不经浮点 number。 */
  readonly amountMicroCoin: string;
  readonly priceBookVersion: string;
  /** 规范化 payload 的 sha256；不包含自身。 */
  readonly digest: string;
}

export type ConsumptionResultState = 'received' | 'applied' | 'rejected' | 'unknown';

export interface ConsumptionResult {
  readonly billId: string;
  readonly digest: string;
  readonly state: ConsumptionResultState;
  readonly externalEntryId?: string;
  readonly appliedAmountMicroCoin?: string;
  readonly reason?: string;
}

export interface ExternalConsumptionPort {
  submitBill(bill: ConsumptionBill): Promise<ConsumptionResult>;
  getBillStatus(key: {
    readonly sourceInstanceId: string;
    readonly billId: string;
  }): Promise<ConsumptionResult>;
}

export type ConsumptionBillPayload = Omit<ConsumptionBill, 'digest'>;

/** 规范化 payload 的稳定 JSON：键顺序固定，便于跨进程比对 digest。 */
export function canonicalConsumptionPayload(payload: ConsumptionBillPayload): string {
  return JSON.stringify({
    sourceSystem: payload.sourceSystem,
    sourceInstanceId: payload.sourceInstanceId,
    externalAccountRef: payload.externalAccountRef,
    billId: payload.billId,
    queryId: payload.queryId,
    taskId: payload.taskId,
    version: payload.version,
    amountMicroCoin: payload.amountMicroCoin,
    priceBookVersion: payload.priceBookVersion,
  });
}

export function computeBillDigest(payload: ConsumptionBillPayload): string {
  return createHash('sha256').update(canonicalConsumptionPayload(payload)).digest('hex');
}

export function buildConsumptionBill(payload: ConsumptionBillPayload): ConsumptionBill {
  return Object.freeze({ ...payload, digest: computeBillDigest(payload) });
}

export type ConsumptionResultValidation =
  | { readonly ok: true; readonly result: ConsumptionResult }
  | { readonly ok: false; readonly reason: string };

/**
 * 验证外部结果：账单键、digest、账户作用域与金额都必须匹配。
 * `applied` 必须有外部流水标识且金额与提交额完全一致。
 */
export function validateConsumptionResult(input: {
  readonly expected: ConsumptionBill;
  readonly result: ConsumptionResult;
}): ConsumptionResultValidation {
  const { expected, result } = input;
  if (result.billId !== expected.billId) {
    return { ok: false, reason: `bill_id_mismatch:${result.billId}` };
  }
  if (result.digest !== expected.digest) {
    return { ok: false, reason: 'digest_mismatch' };
  }
  if (result.state === 'applied') {
    if (!result.externalEntryId || result.externalEntryId.trim().length === 0) {
      return { ok: false, reason: 'applied_without_external_entry' };
    }
    if (result.appliedAmountMicroCoin !== expected.amountMicroCoin) {
      return { ok: false, reason: 'applied_amount_mismatch' };
    }
  }
  if (result.state === 'rejected' && (!result.reason || result.reason.trim().length === 0)) {
    return { ok: false, reason: 'rejected_without_reason' };
  }
  return { ok: true, result };
}

/**
 * 回执到 outbox 状态的映射。`unknown`/`received` 不是终态；`rejected` 不再
 * 换键重试；`confirmed` 只由 `applied` 到达。
 */
export function outboxStateForResult(state: ConsumptionResultState): OutboxState {
  switch (state) {
    case 'applied':
      return 'confirmed';
    case 'received':
      return 'received';
    case 'rejected':
      return 'rejected';
    case 'unknown':
      return 'unknown';
    default: {
      const exhaustive: never = state;
      throw new Error(`unknown_consumption_state:${String(exhaustive)}`);
    }
  }
}

const STATE_RANK: Record<OutboxState, number> = {
  not_exported: 0,
  unknown: 1,
  pending: 1,
  received: 2,
  rejected: 3,
  confirmed: 4,
};

/**
 * 乱序旧结果不得把 `confirmed` 降回 `unknown`。冲突（如金额不符）由调用方
 * 转入人工核对，不做自动覆盖。
 */
export function shouldAdvanceState(current: OutboxState, next: OutboxState): boolean {
  if (current === 'confirmed') return false;
  if (current === 'rejected' && next !== 'confirmed') return false;
  return STATE_RANK[next] >= STATE_RANK[current];
}

/** 有界退避：避免网络故障下的无限紧循环重试。 */
export function nextBackoffMs(attemptCount: number): number {
  const bounded = Math.max(1, Math.min(attemptCount, 16));
  return Math.min(15 * 60_000, 1_000 * 2 ** (bounded - 1));
}
