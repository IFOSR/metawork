/**
 * 账单与外部消费端口（ADR-0042 §5、§6、§7.1）。
 *
 * 端口只描述持久事实与外部系统交互；定价、政策、状态机由 `src/billing/`
 * 的服务实现，SQLite 适配器在 `src/storage/`。
 */

import type { ExactQuantity } from '../metering/contracts.js';
import type { PlatformAbsorptionDecision } from './cost-policy.js';
import type { PriceBookVersion } from './pricing.js';

export const BILL_STATES = ['collecting', 'pending_reconciliation', 'finalized'] as const;
export type BillState = (typeof BILL_STATES)[number];
export type BillUserStatusFilter = 'billed' | 'unconfirmed' | 'no_charge';

export const EXTERNAL_STATES = [
  'not_exported',
  'pending',
  'received',
  'confirmed',
  'unknown',
  'rejected',
] as const;
export type ExternalState = (typeof EXTERNAL_STATES)[number];

export interface QueryBillRecord {
  readonly billId: string;
  readonly queryId: string;
  readonly accountId: string;
  readonly taskId: string | null;
  readonly conversationId: string | null;
  readonly externalAccountRef: string | null;
  readonly version: 1;
  readonly state: BillState;
  readonly billableBaseNanoCny: ExactQuantity;
  readonly amountMicroCoin: string;
  readonly priceBookVersion: string;
  readonly feePolicyVersion: string;
  readonly payerPolicyVersion: string;
  readonly coverage: 'complete' | 'partial' | 'incomplete';
  readonly coverageNote: string | null;
  readonly platformAbsorption: PlatformAbsorptionDecision | null;
  readonly finalizedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface QueryBillLineRecord {
  readonly billId: string;
  readonly lineId: string;
  readonly stage: string | null;
  readonly amountMicroCoin: string;
  readonly rationale: string;
}

export type CostEntryKind = 'reference' | 'verified_actual';

export interface CostEntryRecord {
  readonly costEntryId: string;
  readonly observationId: string;
  readonly queryId: string;
  readonly taskId: string | null;
  readonly stage: string | null;
  readonly priceBookVersion: string;
  readonly payer: string;
  readonly disposition: 'eligible' | 'absorbed' | 'pending';
  readonly reason: string;
  readonly costKind: CostEntryKind;
  readonly costNanoCny: ExactQuantity;
  readonly recordedAt: string;
  readonly evidenceRef: string | null;
}

export interface BillAdjustmentRecord {
  readonly adjustmentId: string;
  readonly billId: string;
  readonly reason: string;
  readonly amountMicroCoin: string;
  readonly authorizedBy: string;
  readonly notes: string;
  readonly externalState: ExternalState;
  readonly externalReference: string | null;
  readonly createdAt: string;
}

export interface BillStorePort {
  findByQueryId(queryId: string): QueryBillRecord | null;
  findByBillId(billId: string): QueryBillRecord | null;
  insert(bill: QueryBillRecord, lines: readonly QueryBillLineRecord[]): void;
  /** 最终单不可变：只有非 finalized 状态可以流入；重复 finalize 幂等。 */
  finalize(input: {
    readonly billId: string;
    readonly billableBaseNanoCny: ExactQuantity;
    readonly amountMicroCoin: string;
    readonly coverage: QueryBillRecord['coverage'];
    readonly coverageNote: string | null;
    readonly platformAbsorption: PlatformAbsorptionDecision | null;
    readonly lines: readonly QueryBillLineRecord[];
    readonly finalizedAt: string;
  }): 'finalized' | 'already_finalized';
  markPendingReconciliation(billId: string, note: string, updatedAt: string): void;
  listLines(billId: string): QueryBillLineRecord[];
  listBillsForAccount(accountId: string, limit?: number): QueryBillRecord[];
  listBillsForAccountPage(input: {
    readonly accountId: string;
    readonly limit: number;
    readonly userStatus?: BillUserStatusFilter;
    readonly before?: {
      readonly createdAt: string;
      readonly billId: string;
    };
  }): QueryBillRecord[];
  listBillsForTask(taskId: string): QueryBillRecord[];
  /** 回滚/对账用：把尚未提交外部消费的账单及计数读出。 */
  sumFinalizedAmounts(queryIds: readonly string[]): bigint;
}

export interface BillAdjustmentPort {
  insert(adjustment: BillAdjustmentRecord): void;
  listForBill(billId: string): BillAdjustmentRecord[];
  updateExternalState(
    adjustmentId: string,
    state: ExternalState,
    externalReference: string | null,
  ): void;
}

/**
 * 最终单与 `consumption_outbox` 必须在同一事务内创建（ADR-0042 §6.2）。
 * 端口只暴露事务边界，不暴露数据库句柄。
 */
export interface BillingUnitOfWork {
  run<T>(work: () => T): T;
}

export interface PriceStorePort {
  insert(version: PriceBookVersion, createdAt: string): void;
  find(priceBookVersion: string): PriceBookVersion | null;
  /** 账户接受 Query 时生效的价格版本选择委托给调用方；这里只做读取。 */
  listVersions(): PriceBookVersion[];
}

export interface CostEntryPort {
  insert(entries: readonly CostEntryRecord[]): number;
  listForQuery(queryId: string): CostEntryRecord[];
  /** 迟到的实际采购成本单独记录，不自动追加到已终结账单。 */
  recordVerifiedActual(entry: CostEntryRecord): 'recorded' | 'duplicate';
}

export const OUTBOX_STATES = [
  'not_exported',
  'pending',
  'received',
  'confirmed',
  'unknown',
  'rejected',
] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export interface ConsumptionOutboxRecord {
  readonly billId: string;
  readonly sourceInstanceId: string;
  readonly externalAccountRef: string;
  readonly payloadJson: string;
  readonly payloadDigest: string;
  readonly amountMicroCoin: string;
  readonly state: OutboxState;
  readonly attemptCount: number;
  readonly lastAttemptAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConsumptionReceiptRecord {
  readonly receiptId: string;
  readonly billId: string;
  readonly sourceInstanceId: string;
  readonly digest: string;
  readonly state: 'received' | 'applied' | 'rejected' | 'unknown';
  readonly externalEntryId: string | null;
  readonly appliedAmountMicroCoin: string | null;
  readonly reason: string | null;
  readonly observedAt: string;
}

export interface ConsumptionOutboxPort {
  /** 与最终单同一事务创建（ADR-0042 §6.2）。 */
  insert(record: ConsumptionOutboxRecord): void;
  find(billId: string): ConsumptionOutboxRecord | null;
  claimForSubmission(input: {
    readonly billId: string;
    readonly attemptedAt: string;
  }): boolean;
  recordAttempt(input: {
    readonly billId: string;
    readonly state: OutboxState;
    readonly attemptedAt: string;
    readonly nextAttemptAt: string | null;
    readonly lastError: string | null;
  }): void;
  listByStates(states: readonly OutboxState[], limit: number): ConsumptionOutboxRecord[];
  appendReceipt(receipt: ConsumptionReceiptRecord): void;
  listReceipts(billId: string): ConsumptionReceiptRecord[];
  latestReceipt(billId: string): ConsumptionReceiptRecord | null;
  /** `sourceInstanceId + billId` 幂等键必须稳定，备份恢复不得重建。 */
  readSourceInstanceId(): string | null;
  ensureSourceInstanceId(sourceInstanceId: string, createdAt: string): string;
}
