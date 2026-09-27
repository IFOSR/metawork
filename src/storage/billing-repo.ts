/**
 * 账单相关 SQLite 适配器（ADR-0042 §7.2）。
 *
 * 价格版本不可变；最终单与明细在同一事务写入；调整记录只引用原单，
 * 不覆写历史。
 */

import type Database from 'better-sqlite3';
import type {
  BillAdjustmentPort,
  BillingUnitOfWork,
  BillAdjustmentRecord,
  BillStorePort,
  CostEntryPort,
  CostEntryRecord,
  PriceStorePort,
  QueryBillLineRecord,
  QueryBillRecord,
} from '../billing/ports.js';
import type { PlatformAbsorptionDecision } from '../billing/cost-policy.js';
import {
  createPriceBookVersion,
  type PriceBookVersion,
  type PriceUnitInput,
} from '../billing/pricing.js';
import { rational, type Rational } from '../billing/money.js';

interface PriceRow {
  price_book_version: string;
  currency: 'CNY';
  markup_bps: string;
  fee_policy_version: string;
  effective_from: string;
  exchange_rate_json: string;
  units_json: string;
}

interface BillRow {
  bill_id: string;
  query_id: string;
  account_id: string;
  task_id: string | null;
  conversation_id: string | null;
  external_account_ref: string | null;
  version: number;
  state: QueryBillRecord['state'];
  billable_base_nano_cny_numerator: string;
  billable_base_nano_cny_denominator: string;
  amount_micro_coin: string;
  price_book_version: string;
  fee_policy_version: string;
  payer_policy_version: string;
  coverage: QueryBillRecord['coverage'];
  coverage_note: string | null;
  platform_absorption_json: string;
  finalized_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AdjustmentRow {
  adjustment_id: string;
  bill_id: string;
  reason: string;
  amount_micro_coin: string;
  authorized_by: string;
  notes: string;
  external_state: BillAdjustmentRecord['externalState'];
  external_reference: string | null;
  created_at: string;
}

interface BillLineRow {
  bill_id: string;
  line_id: string;
  stage: string | null;
  amount_micro_coin: string;
  rationale: string;
}

interface CostEntryRow {
  cost_entry_id: string;
  observation_id: string;
  query_id: string;
  task_id: string | null;
  stage: string | null;
  price_book_version: string;
  payer: string;
  disposition: CostEntryRecord['disposition'];
  reason: string;
  cost_kind: CostEntryRecord['costKind'];
  cost_nano_cny_numerator: string;
  cost_nano_cny_denominator: string;
  recorded_at: string;
  evidence_ref: string | null;
}

export class SqliteBillingUnitOfWork implements BillingUnitOfWork {
  constructor(private readonly db: Database.Database) {}

  run<T>(work: () => T): T {
    return this.db.transaction(work)();
  }
}

export class SqlitePriceStore implements PriceStorePort {
  constructor(private readonly db: Database.Database) {}

  insert(version: PriceBookVersion, createdAt: string): void {
    this.db.prepare(`
      INSERT INTO billing_price_versions (
        price_book_version, currency, markup_bps, fee_policy_version, effective_from,
        exchange_rate_json, units_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      version.priceBookVersion,
      version.currency,
      version.markupBps.toString(),
      version.feePolicyVersion,
      version.effectiveFrom,
      JSON.stringify(version.exchangeRate ?? null, (_key, value: unknown) => (
        typeof value === 'bigint' ? value.toString() : value
      )),
      JSON.stringify([...version.units.values()].map(unit => ({
        resource: unit.resource,
        metric: unit.metric,
        agentClassRef: unit.agentClassRef ?? null,
        providerRef: unit.providerRef ?? null,
        modelId: unit.modelId ?? null,
        sourceCurrency: unit.sourceCurrency,
        numerator: unit.nanoCnyPerUnit.numerator.toString(),
        denominator: unit.nanoCnyPerUnit.denominator.toString(),
      }))),
      createdAt,
    );
  }

  find(priceBookVersion: string): PriceBookVersion | null {
    const row = this.db.prepare(
      'SELECT * FROM billing_price_versions WHERE price_book_version = ?',
    ).get(priceBookVersion) as PriceRow | undefined;
    return row ? rowToPriceBook(row) : null;
  }

  listVersions(): PriceBookVersion[] {
    const rows = this.db.prepare(
      'SELECT * FROM billing_price_versions ORDER BY effective_from, price_book_version',
    ).all() as PriceRow[];
    return rows.map(rowToPriceBook);
  }

  findVersions(versions: readonly string[]): PriceBookVersion[] {
    const rows = this.db.prepare(`
      SELECT * FROM billing_price_versions WHERE price_book_version IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(versions)) as PriceRow[];
    return rows.map(rowToPriceBook);
  }
}

export class SqliteCostEntryStore implements CostEntryPort {
  constructor(private readonly db: Database.Database) {}

  insert(entries: readonly CostEntryRecord[]): number {
    const statement = this.db.prepare(`
      INSERT INTO cost_entries (
        cost_entry_id, observation_id, query_id, task_id, stage, price_book_version,
        payer, disposition, reason, cost_kind, cost_nano_cny_numerator,
        cost_nano_cny_denominator, recorded_at, evidence_ref
      ) VALUES (
        @cost_entry_id, @observation_id, @query_id, @task_id, @stage, @price_book_version,
        @payer, @disposition, @reason, @cost_kind, @cost_nano_cny_numerator,
        @cost_nano_cny_denominator, @recorded_at, @evidence_ref
      )
      ON CONFLICT(observation_id, cost_kind, price_book_version) DO UPDATE SET
        task_id = excluded.task_id,
        stage = excluded.stage,
        payer = excluded.payer,
        disposition = excluded.disposition,
        reason = excluded.reason,
        cost_nano_cny_numerator = excluded.cost_nano_cny_numerator,
        cost_nano_cny_denominator = excluded.cost_nano_cny_denominator,
        recorded_at = excluded.recorded_at,
        evidence_ref = excluded.evidence_ref
    `);
    return this.db.transaction(() => {
      let inserted = 0;
      for (const entry of entries) {
        inserted += statement.run({
          cost_entry_id: entry.costEntryId,
          observation_id: entry.observationId,
          query_id: entry.queryId,
          task_id: entry.taskId,
          stage: entry.stage,
          price_book_version: entry.priceBookVersion,
          payer: entry.payer,
          disposition: entry.disposition,
          reason: entry.reason,
          cost_kind: entry.costKind,
          cost_nano_cny_numerator: entry.costNanoCny.numerator,
          cost_nano_cny_denominator: entry.costNanoCny.denominator,
          recorded_at: entry.recordedAt,
          evidence_ref: entry.evidenceRef,
        }).changes;
      }
      return inserted;
    })();
  }

  listForQuery(queryId: string): CostEntryRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM cost_entries WHERE query_id = ?
      ORDER BY recorded_at, cost_entry_id
    `).all(queryId) as CostEntryRow[];
    return rows.map(rowToCostEntry);
  }

  listForQueries(queryIds: readonly string[]): CostEntryRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM cost_entries WHERE query_id IN (SELECT value FROM json_each(?))
      ORDER BY recorded_at, cost_entry_id
    `).all(JSON.stringify(queryIds)) as CostEntryRow[];
    return rows.map(rowToCostEntry);
  }

  recordVerifiedActual(entry: CostEntryRecord): 'recorded' | 'duplicate' {
    const changes = this.db.prepare(`
      INSERT INTO cost_entries (
        cost_entry_id, observation_id, query_id, task_id, stage, price_book_version,
        payer, disposition, reason, cost_kind, cost_nano_cny_numerator,
        cost_nano_cny_denominator, recorded_at, evidence_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified_actual', ?, ?, ?, ?)
      ON CONFLICT(observation_id, cost_kind, price_book_version) DO NOTHING
    `).run(
      entry.costEntryId,
      entry.observationId,
      entry.queryId,
      entry.taskId,
      entry.stage,
      entry.priceBookVersion,
      entry.payer,
      entry.disposition,
      entry.reason,
      entry.costNanoCny.numerator,
      entry.costNanoCny.denominator,
      entry.recordedAt,
      entry.evidenceRef,
    ).changes;
    return changes === 1 ? 'recorded' : 'duplicate';
  }
}

export class SqliteBillStore implements BillStorePort {
  constructor(private readonly db: Database.Database) {}

  findByQueryId(queryId: string): QueryBillRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM query_bills WHERE query_id = ?',
    ).get(queryId) as BillRow | undefined;
    return row ? rowToBill(row) : null;
  }

  findByBillId(billId: string): QueryBillRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM query_bills WHERE bill_id = ?',
    ).get(billId) as BillRow | undefined;
    return row ? rowToBill(row) : null;
  }

  insert(bill: QueryBillRecord, lines: readonly QueryBillLineRecord[]): void {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO query_bills (
          bill_id, query_id, account_id, task_id, conversation_id, external_account_ref,
          version, state, billable_base_nano_cny_numerator, billable_base_nano_cny_denominator,
          amount_micro_coin, price_book_version, fee_policy_version, payer_policy_version,
          coverage, coverage_note, platform_absorption_json, finalized_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        bill.billId,
        bill.queryId,
        bill.accountId,
        bill.taskId,
        bill.conversationId,
        bill.externalAccountRef,
        bill.version,
        bill.state,
        bill.billableBaseNanoCny.numerator,
        bill.billableBaseNanoCny.denominator,
        bill.amountMicroCoin,
        bill.priceBookVersion,
        bill.feePolicyVersion,
        bill.payerPolicyVersion,
        bill.coverage,
        bill.coverageNote,
        JSON.stringify(bill.platformAbsorption ?? null),
        bill.finalizedAt,
        bill.createdAt,
        bill.updatedAt,
      );
      this.insertLines(bill.billId, lines);
    })();
  }

  finalize(input: {
    billId: string;
    billableBaseNanoCny: { numerator: string; denominator: string };
    amountMicroCoin: string;
    coverage: QueryBillRecord['coverage'];
    coverageNote: string | null;
    platformAbsorption: PlatformAbsorptionDecision | null;
    lines: readonly QueryBillLineRecord[];
    finalizedAt: string;
  }): 'finalized' | 'already_finalized' {
    return this.db.transaction(() => {
      const current = this.findByBillId(input.billId);
      if (!current) throw new Error(`unknown_bill:${input.billId}`);
      if (current.state === 'finalized') return 'already_finalized';
      const changes = this.db.prepare(`
        UPDATE query_bills
        SET state = 'finalized',
            task_id = COALESCE(task_id, (
              SELECT cost_task_id FROM query_task_links WHERE query_id = query_bills.query_id
            )),
            billable_base_nano_cny_numerator = ?,
            billable_base_nano_cny_denominator = ?,
            amount_micro_coin = ?,
            coverage = ?,
            coverage_note = ?,
            platform_absorption_json = ?,
            finalized_at = ?,
            updated_at = ?
        WHERE bill_id = ? AND state <> 'finalized'
      `).run(
        input.billableBaseNanoCny.numerator,
        input.billableBaseNanoCny.denominator,
        input.amountMicroCoin,
        input.coverage,
        input.coverageNote,
        JSON.stringify(input.platformAbsorption ?? null),
        input.finalizedAt,
        input.finalizedAt,
        input.billId,
      ).changes;
      if (changes !== 1) return 'already_finalized';
      this.db.prepare('DELETE FROM query_bill_lines WHERE bill_id = ?').run(input.billId);
      this.insertLines(input.billId, input.lines);
      return 'finalized';
    })();
  }

  markPendingReconciliation(billId: string, note: string, updatedAt: string): void {
    this.db.prepare(`
      UPDATE query_bills
      SET state = 'pending_reconciliation', coverage = 'incomplete',
          coverage_note = ?, updated_at = ?
      WHERE bill_id = ? AND state <> 'finalized'
    `).run(note, updatedAt, billId);
  }

  listLines(billId: string): QueryBillLineRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM query_bill_lines WHERE bill_id = ? ORDER BY line_id
    `).all(billId) as BillLineRow[];
    return rows.map(rowToBillLine);
  }

  listLinesForBills(billIds: readonly string[]): QueryBillLineRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM query_bill_lines WHERE bill_id IN (SELECT value FROM json_each(?))
      ORDER BY line_id
    `).all(JSON.stringify(billIds)) as BillLineRow[];
    return rows.map(rowToBillLine);
  }

  findForHistory(queryIds: readonly string[], taskIds: readonly string[]): QueryBillRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM query_bills
      WHERE query_id IN (SELECT value FROM json_each(?))
         OR task_id IN (SELECT value FROM json_each(?))
      ORDER BY created_at, bill_id
    `).all(JSON.stringify(queryIds), JSON.stringify(taskIds)) as BillRow[];
    return rows.map(rowToBill);
  }

  listBillsForAccount(accountId: string, limit?: number): QueryBillRecord[] {
    const sql = limit === undefined
      ? 'SELECT * FROM query_bills WHERE account_id = ? ORDER BY created_at DESC, bill_id DESC'
      : 'SELECT * FROM query_bills WHERE account_id = ? ORDER BY created_at DESC, bill_id DESC LIMIT ?';
    const rows = (limit === undefined
      ? this.db.prepare(sql).all(accountId)
      : this.db.prepare(sql).all(accountId, limit)) as BillRow[];
    return rows.map(rowToBill);
  }

  listBillsForAccountPage(input: {
    accountId: string;
    limit: number;
    userStatus?: 'billed' | 'unconfirmed' | 'no_charge';
    before?: { createdAt: string; billId: string };
  }): QueryBillRecord[] {
    const where = ['account_id = ?'];
    const params: unknown[] = [input.accountId];
    if (input.userStatus === 'billed') {
      where.push(`state = 'finalized' AND amount_micro_coin <> '0'`);
    } else if (input.userStatus === 'no_charge') {
      where.push(`state = 'finalized' AND amount_micro_coin = '0'`);
    } else if (input.userStatus === 'unconfirmed') {
      where.push(`state <> 'finalized'`);
    }
    if (input.before) {
      where.push(`(
        created_at < ?
        OR (created_at = ? AND bill_id < ?)
      )`);
      params.push(input.before.createdAt, input.before.createdAt, input.before.billId);
    }
    params.push(input.limit);
    const rows = this.db.prepare(`
      SELECT * FROM query_bills
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, bill_id DESC
      LIMIT ?
    `).all(...params);
    return (rows as BillRow[]).map(rowToBill);
  }

  listBillsForTask(taskId: string): QueryBillRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM query_bills WHERE task_id = ?
      ORDER BY created_at, bill_id
    `).all(taskId) as BillRow[];
    return rows.map(rowToBill);
  }

  listBillsForConversation(conversationId: string): QueryBillRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM query_bills WHERE conversation_id = ?
      ORDER BY created_at, bill_id
    `).all(conversationId) as BillRow[];
    return rows.map(rowToBill);
  }

  sumFinalizedAmounts(queryIds: readonly string[]): bigint {
    if (queryIds.length === 0) return 0n;
    const placeholders = queryIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT amount_micro_coin FROM query_bills
      WHERE state = 'finalized' AND query_id IN (${placeholders})
    `).all(...queryIds) as Array<{ amount_micro_coin: string }>;
    return rows.reduce((sum, row) => sum + BigInt(row.amount_micro_coin), 0n);
  }

  private insertLines(
    billId: string,
    lines: readonly QueryBillLineRecord[],
  ): void {
    const statement = this.db.prepare(`
      INSERT INTO query_bill_lines (bill_id, line_id, stage, amount_micro_coin, rationale)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const line of lines) {
      statement.run(billId, line.lineId, line.stage, line.amountMicroCoin, line.rationale);
    }
  }
}

export class SqliteBillAdjustmentStore implements BillAdjustmentPort {
  constructor(private readonly db: Database.Database) {}

  insert(adjustment: BillAdjustmentRecord): void {
    this.db.prepare(`
      INSERT INTO bill_adjustments (
        adjustment_id, bill_id, reason, amount_micro_coin, authorized_by, notes,
        external_state, external_reference, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      adjustment.adjustmentId,
      adjustment.billId,
      adjustment.reason,
      adjustment.amountMicroCoin,
      adjustment.authorizedBy,
      adjustment.notes,
      adjustment.externalState,
      adjustment.externalReference,
      adjustment.createdAt,
    );
  }

  listForBill(billId: string): BillAdjustmentRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM bill_adjustments WHERE bill_id = ?
      ORDER BY created_at, adjustment_id
    `).all(billId) as AdjustmentRow[];
    return rows.map(rowToAdjustment);
  }

  listForBills(billIds: readonly string[]): BillAdjustmentRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM bill_adjustments WHERE bill_id IN (SELECT value FROM json_each(?))
      ORDER BY created_at, adjustment_id
    `).all(JSON.stringify(billIds)) as AdjustmentRow[];
    return rows.map(rowToAdjustment);
  }

  updateExternalState(
    adjustmentId: string,
    state: BillAdjustmentRecord['externalState'],
    externalReference: string | null,
  ): void {
    this.db.prepare(`
      UPDATE bill_adjustments
      SET external_state = ?, external_reference = COALESCE(?, external_reference)
      WHERE adjustment_id = ?
    `).run(state, externalReference, adjustmentId);
  }
}

function rowToBillLine(row: BillLineRow): QueryBillLineRecord {
  return {
    billId: row.bill_id,
    lineId: row.line_id,
    stage: row.stage,
    amountMicroCoin: row.amount_micro_coin,
    rationale: row.rationale,
  };
}

function rowToAdjustment(row: AdjustmentRow): BillAdjustmentRecord {
  return {
    adjustmentId: row.adjustment_id,
    billId: row.bill_id,
    reason: row.reason,
    amountMicroCoin: row.amount_micro_coin,
    authorizedBy: row.authorized_by,
    notes: row.notes,
    externalState: row.external_state,
    externalReference: row.external_reference,
    createdAt: row.created_at,
  };
}

function rowToPriceBook(row: PriceRow): PriceBookVersion {
  const units = JSON.parse(row.units_json) as Array<{
    resource: PriceUnitInput['resource'];
    metric: string;
    agentClassRef?: string | null;
    providerRef?: string | null;
    modelId?: string | null;
    sourceCurrency: string | null;
    numerator: string;
    denominator: string;
  }>;
  const exchangeRate = JSON.parse(row.exchange_rate_json) as
    | { sourceCurrency: string; nanoCnyPerSourceUnit: { numerator: string; denominator: string }; effectiveFrom: string }
    | null;
  return createPriceBookVersion({
    priceBookVersion: row.price_book_version,
    currency: row.currency,
    markupBps: BigInt(row.markup_bps),
    feePolicyVersion: row.fee_policy_version,
    effectiveFrom: row.effective_from,
    ...(exchangeRate
      ? {
          exchangeRate: {
            sourceCurrency: exchangeRate.sourceCurrency,
            effectiveFrom: exchangeRate.effectiveFrom,
            nanoCnyPerSourceUnit: rational(
              BigInt(exchangeRate.nanoCnyPerSourceUnit.numerator),
              BigInt(exchangeRate.nanoCnyPerSourceUnit.denominator),
            ),
          },
        }
      : {}),
    units: units.map(unit => ({
      resource: unit.resource,
      metric: unit.metric,
      ...(unit.agentClassRef ? { agentClassRef: unit.agentClassRef } : {}),
      ...(unit.providerRef ? { providerRef: unit.providerRef } : {}),
      ...(unit.modelId ? { modelId: unit.modelId } : {}),
      ...(unit.sourceCurrency ? { sourceCurrency: unit.sourceCurrency } : {}),
      nanoCnyPerUnit: rational(BigInt(unit.numerator), BigInt(unit.denominator)),
    })),
  });
}

function rowToBill(row: BillRow): QueryBillRecord {
  return {
    billId: row.bill_id,
    queryId: row.query_id,
    accountId: row.account_id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    externalAccountRef: row.external_account_ref,
    version: 1,
    state: row.state,
    billableBaseNanoCny: {
      numerator: row.billable_base_nano_cny_numerator,
      denominator: row.billable_base_nano_cny_denominator,
    },
    amountMicroCoin: row.amount_micro_coin,
    priceBookVersion: row.price_book_version,
    feePolicyVersion: row.fee_policy_version,
    payerPolicyVersion: row.payer_policy_version,
    coverage: row.coverage,
    coverageNote: row.coverage_note,
    platformAbsorption: JSON.parse(row.platform_absorption_json) as PlatformAbsorptionDecision | null,
    finalizedAt: row.finalized_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCostEntry(row: CostEntryRow): CostEntryRecord {
  return {
    costEntryId: row.cost_entry_id,
    observationId: row.observation_id,
    queryId: row.query_id,
    taskId: row.task_id,
    stage: row.stage,
    priceBookVersion: row.price_book_version,
    payer: row.payer,
    disposition: row.disposition,
    reason: row.reason,
    costKind: row.cost_kind,
    costNanoCny: {
      numerator: row.cost_nano_cny_numerator,
      denominator: row.cost_nano_cny_denominator,
    },
    recordedAt: row.recorded_at,
    evidenceRef: row.evidence_ref,
  };
}

export function optionalRational(value: string | null): Rational | null {
  if (value === null) return null;
  const match = /^(-?\d+)\/(\d+)$/u.exec(value);
  return match ? rational(BigInt(match[1]!), BigInt(match[2]!)) : rational(BigInt(value));
}
