/**
 * `ConsumptionOutboxPort` 的 SQLite 实现（ADR-0042 §6.2）。
 *
 * outbox 是 append-only 的提交意图；回执单独追加，`source_instance_id` 一旦
 * 持久化就不再重建，备份恢复必须复用它。
 */

import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type {
  ConsumptionOutboxPort,
  ConsumptionOutboxRecord,
  ConsumptionReceiptRecord,
  OutboxState,
} from '../billing/ports.js';
import { shouldAdvanceState } from '../billing/consumption-contract.js';

interface OutboxRow {
  bill_id: string;
  source_instance_id: string;
  external_account_ref: string;
  payload_json: string;
  payload_digest: string;
  amount_micro_coin: string;
  state: OutboxState;
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ReceiptRow {
  receipt_id: string;
  bill_id: string;
  source_instance_id: string;
  digest: string;
  state: ConsumptionReceiptRecord['state'];
  external_entry_id: string | null;
  applied_amount_micro_coin: string | null;
  reason: string | null;
  observed_at: string;
}

export class SqliteConsumptionOutboxStore implements ConsumptionOutboxPort {
  constructor(
    private readonly db: Database.Database,
    private readonly createId: (prefix: string) => string = prefix => `${prefix}_${nanoid(12)}`,
  ) {}

  insert(record: ConsumptionOutboxRecord): void {
    this.db.prepare(`
      INSERT INTO consumption_outbox (
        bill_id, source_instance_id, external_account_ref, payload_json, payload_digest,
        amount_micro_coin, state, attempt_count, last_attempt_at, next_attempt_at,
        last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.billId,
      record.sourceInstanceId,
      record.externalAccountRef,
      record.payloadJson,
      record.payloadDigest,
      record.amountMicroCoin,
      record.state,
      record.attemptCount,
      record.lastAttemptAt,
      record.nextAttemptAt,
      record.lastError,
      record.createdAt,
      record.updatedAt,
    );
  }

  find(billId: string): ConsumptionOutboxRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM consumption_outbox WHERE bill_id = ?',
    ).get(billId) as OutboxRow | undefined;
    return row ? rowToOutbox(row) : null;
  }

  claimForSubmission(input: { billId: string; attemptedAt: string }): boolean {
    const changes = this.db.prepare(`
      UPDATE consumption_outbox
      SET attempt_count = attempt_count + 1,
          last_attempt_at = ?,
          state = CASE WHEN state = 'not_exported' THEN 'pending' ELSE state END,
          next_attempt_at = ?,
          updated_at = ?
      WHERE bill_id = ?
        AND state IN ('not_exported', 'pending', 'unknown')
        AND (last_error IS NULL OR last_error NOT LIKE 'manual_review:%')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    `).run(input.attemptedAt,
      new Date(Date.parse(input.attemptedAt) + 60_000).toISOString(),
      input.attemptedAt, input.billId, input.attemptedAt).changes;
    return changes === 1;
  }

  recordAttempt(input: {
    billId: string;
    state: OutboxState;
    attemptedAt: string;
    nextAttemptAt: string | null;
    lastError: string | null;
  }): void {
    const current = this.find(input.billId);
    if (!current || !shouldAdvanceState(current.state, input.state)) return;
    this.db.prepare(`
      UPDATE consumption_outbox
      SET state = ?, last_attempt_at = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE bill_id = ?
    `).run(
      input.state,
      input.attemptedAt,
      input.nextAttemptAt,
      input.lastError,
      input.attemptedAt,
      input.billId,
    );
  }

  listByStates(states: readonly OutboxState[], limit: number): ConsumptionOutboxRecord[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT * FROM consumption_outbox
      WHERE state IN (${placeholders})
        AND (last_error IS NULL OR last_error NOT LIKE 'manual_review:%')
      ORDER BY created_at, bill_id LIMIT ?
    `).all(...states, limit) as OutboxRow[];
    return rows.map(rowToOutbox);
  }

  appendReceipt(receipt: ConsumptionReceiptRecord): void {
    this.db.prepare(`
      INSERT INTO consumption_receipts (
        receipt_id, bill_id, source_instance_id, digest, state, external_entry_id,
        applied_amount_micro_coin, reason, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(receipt_id) DO NOTHING
    `).run(
      receipt.receiptId,
      receipt.billId,
      receipt.sourceInstanceId,
      receipt.digest,
      receipt.state,
      receipt.externalEntryId,
      receipt.appliedAmountMicroCoin,
      receipt.reason,
      receipt.observedAt,
    );
  }

  listReceipts(billId: string): ConsumptionReceiptRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM consumption_receipts WHERE bill_id = ?
      ORDER BY observed_at, receipt_id
    `).all(billId) as ReceiptRow[];
    return rows.map(rowToReceipt);
  }

  latestReceipt(billId: string): ConsumptionReceiptRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM consumption_receipts WHERE bill_id = ?
      ORDER BY CASE state WHEN 'applied' THEN 4 WHEN 'rejected' THEN 3
        WHEN 'received' THEN 2 ELSE 1 END DESC, observed_at DESC, receipt_id DESC LIMIT 1
    `).get(billId) as ReceiptRow | undefined;
    return row ? rowToReceipt(row) : null;
  }

  findForBills(billIds: readonly string[]): ConsumptionOutboxRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM consumption_outbox WHERE bill_id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(billIds)) as OutboxRow[];
    return rows.map(rowToOutbox);
  }

  latestReceiptsForBills(billIds: readonly string[]): ConsumptionReceiptRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT *, row_number() OVER (
          PARTITION BY bill_id
          ORDER BY CASE state WHEN 'applied' THEN 4 WHEN 'rejected' THEN 3
            WHEN 'received' THEN 2 ELSE 1 END DESC, observed_at DESC, receipt_id DESC
        ) AS position FROM consumption_receipts
        WHERE bill_id IN (SELECT value FROM json_each(?))
      ) WHERE position = 1
    `).all(JSON.stringify(billIds)) as ReceiptRow[];
    return rows.map(rowToReceipt);
  }

  readSourceInstanceId(): string | null {
    const row = this.db.prepare(
      'SELECT source_instance_id FROM billing_source_instance LIMIT 1',
    ).get() as { source_instance_id: string } | undefined;
    return row?.source_instance_id ?? null;
  }

  /**
   * 首次调用生成稳定标识；后续调用必须复用，克隆安装不得生成第二个发送者。
   */
  ensureSourceInstanceId(sourceInstanceId: string, createdAt: string): string {
    return this.db.transaction(() => {
      const existing = this.readSourceInstanceId();
      if (existing) return existing;
      this.db.prepare(`
        INSERT INTO billing_source_instance (source_instance_id, created_at)
        VALUES (?, ?)
      `).run(sourceInstanceId, createdAt);
      return sourceInstanceId;
    })();
  }

  createReceiptId(): string {
    return this.createId('receipt');
  }
}

function rowToOutbox(row: OutboxRow): ConsumptionOutboxRecord {
  return {
    billId: row.bill_id,
    sourceInstanceId: row.source_instance_id,
    externalAccountRef: row.external_account_ref,
    payloadJson: row.payload_json,
    payloadDigest: row.payload_digest,
    amountMicroCoin: row.amount_micro_coin,
    state: row.state,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToReceipt(row: ReceiptRow): ConsumptionReceiptRecord {
  return {
    receiptId: row.receipt_id,
    billId: row.bill_id,
    sourceInstanceId: row.source_instance_id,
    digest: row.digest,
    state: row.state,
    externalEntryId: row.external_entry_id,
    appliedAmountMicroCoin: row.applied_amount_micro_coin,
    reason: row.reason,
    observedAt: row.observed_at,
  };
}
