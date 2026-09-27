import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/storage/database.js';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';
import { SqliteQueryContextStore } from '../../src/storage/query-usage-context-repo.js';
import { SqliteMeteringStore } from '../../src/storage/metering-repo.js';
import { SqliteConsumptionOutboxStore } from '../../src/storage/consumption-outbox-repo.js';
import { createQueryBillService } from '../../src/billing/query-bill-service.js';
import { createBillQueryService } from '../../src/billing/bill-query-service.js';
import { formatDecimalUnits } from '../../src/billing/money.js';
import { createConsumptionExportService } from '../../src/billing/consumption-export-service.js';
import { createQueryContextService } from '../../src/metering/query-context-service.js';
import { createFakeConsumptionServer } from '../../src/integrations/external-consumption-client.js';
import {
  PLATFORM_PRICE_BOOK,
  seedPriceBook,
  type BillingHarness,
} from '../billing/harness.js';
import {
  SqliteBillAdjustmentStore,
  SqliteBillStore,
  SqliteBillingUnitOfWork,
  SqliteCostEntryStore,
  SqlitePriceStore,
} from '../../src/storage/billing-repo.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metawork-billing-'));
  tempDirs.push(dir);
  return join(dir, 'account.db');
}

function billingSchemaTables(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all() as Array<{ name: string }>).map(row => row.name).sort();
}

describe('billing schema migration and recovery', () => {
  it('upgrades a schema 38 database to the current billing schema', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    // Simulate an already-upgraded-to-38 account database without billing facts.
    for (const table of [
      'query_bill_lines',
      'query_bills',
      'cost_entries',
      'usage_normalization_issues',
      'usage_observations',
      'metering_spans',
      'execution_usage_contexts',
      'query_task_links',
      'query_usage_contexts',
      'consumption_receipts',
      'consumption_outbox',
      'bill_adjustments',
      'billing_price_versions',
      'billing_source_instance',
    ]) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec('UPDATE schema_version SET version = 38');
    runMigrations(db);
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    expect(billingSchemaTables(db)).toEqual(expect.arrayContaining([
      'query_usage_contexts',
      'query_bills',
      'consumption_outbox',
      'billing_source_instance',
    ]));
    // Idempotent: a second run is a no-op.
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  it('keeps exact amounts, outbox keys and receipts across WAL reopen', () => {
    const dbPath = tempDbPath();
    const first = createDatabase(dbPath);
    const harness = harnessFor(first);
    seedPriceBook(harness);
    const queryId = 'query-1';
    harness.bindExternalAccountRef('acct-ext');
    beginQueryFor(harness, queryId, 'req-1');
    harness.setExportEnabled(true);
    harness.metering.insertObservations([{
      observationId: 'obs-1',
      spanId: null,
      sourceId: 'planner',
      sourceEventKey: 'evt-1',
      sourceScope: 'model_request',
      callId: 'call-1',
      queryId,
      executionSegmentId: null,
      taskId: null,
      stage: 'planning',
      reason: 'primary',
      resource: 'model_tokens',
      metric: 'input',
      unit: 'token',
      quantityNumerator: '1000',
      quantityDenominator: '1',
      quality: 'reported',
      countsTowardTotal: true,
      payer: 'platform',
      capturedAt: '2026-09-21T10:00:05.000Z',
      providerBindingVersion: null,
      evidenceRef: null,
      normalizationRuleVersion: 'usage-normalizer-v1',
    }]);
    const finalized = harness.billService.finalizeQueryBill({
      queryId,
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    if (finalized.status !== 'finalized') throw new Error(`unexpected ${finalized.status}`);
    const billId = finalized.bill.billId;
    const digest = harness.outbox.find(billId)!.payloadDigest;
    first.close();

    const reopened = createDatabase(dbPath);
    const store = new SqliteQueryContextStore(reopened);
    const bills = new SqliteBillStore(reopened);
    const outbox = new SqliteConsumptionOutboxStore(reopened);
    expect(store.findById(queryId)?.priceBookVersion).toBe(PLATFORM_PRICE_BOOK.priceBookVersion);
    expect(bills.findByBillId(billId)?.amountMicroCoin).toBe('28');
    expect(bills.findByBillId(billId)?.state).toBe('finalized');
    expect(outbox.find(billId)?.payloadDigest).toBe(digest);
    expect(outbox.readSourceInstanceId()).toBe('instance-test');
    reopened.close();
  });

  it('enforces Query identity, bill uniqueness and outbox idempotency keys', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const store = new SqliteQueryContextStore(db);
    const context = {
      queryId: 'q1',
      accountId: 'account-1',
      ingress: 'web' as const,
      requestKey: 'req-1',
      requestPayloadDigest: 'digest-1',
      conversationId: null,
      requestId: 'request-1',
      turnId: null,
      executionSegmentId: null,
      priceBookVersion: 'pb',
      feePolicyVersion: 'fp',
      payerPolicyVersion: 'pp',
      acceptedAt: '2026-09-21T10:00:00.000Z',
    };
    store.insert(context);
    // Same account + ingress + request key cannot be inserted twice.
    expect(() => store.insert({ ...context, queryId: 'q2' })).toThrow(/UNIQUE/u);
    // A bill cannot exist without its Query context.
    expect(() => db.prepare(`
      INSERT INTO query_bills (
        bill_id, query_id, account_id, version, state, price_book_version,
        fee_policy_version, payer_policy_version, coverage, created_at, updated_at
      ) VALUES ('b1', 'missing', 'account-1', 1, 'collecting', 'pb', 'fp', 'pp', 'incomplete', 'now', 'now')
    `).run()).toThrow(/FOREIGN KEY/u);
    store.insert({ ...context, queryId: 'q3', requestKey: 'req-2' });
    db.prepare(`
      INSERT INTO query_bills (
        bill_id, query_id, account_id, version, state, price_book_version,
        fee_policy_version, payer_policy_version, coverage, created_at, updated_at
      ) VALUES ('b1', 'q1', 'account-1', 1, 'collecting', 'pb', 'fp', 'pp', 'incomplete', 'now', 'now')
    `).run();
    // One final bill per Query.
    expect(() => db.prepare(`
      INSERT INTO query_bills (
        bill_id, query_id, account_id, version, state, price_book_version,
        fee_policy_version, payer_policy_version, coverage, created_at, updated_at
      ) VALUES ('b2', 'q1', 'account-1', 1, 'collecting', 'pb', 'fp', 'pp', 'incomplete', 'now', 'now')
    `).run()).toThrow(/UNIQUE/u);
    db.close();
  });

  it('does not let an external receipt exist without an outbox intent', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    expect(() => db.prepare(`
      INSERT INTO consumption_receipts (
        receipt_id, bill_id, source_instance_id, digest, state, observed_at
      ) VALUES ('r1', 'missing-bill', 'instance', 'digest', 'received', 'now')
    `).run()).toThrow(/FOREIGN KEY/u);
    db.close();
  });
});

describe('acceptance lifecycle', () => {
  it('keeps Q1/Q2/Q3 attribution separate and survives an external timeout', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const harness = harnessFor(db);
    seedPriceBook(harness);
    harness.setExportEnabled(true);
    harness.bindExternalAccountRef('acct-ext');

    // Q1: clarification without a Task, but the Planner call already cost money.
    beginQueryFor(harness, 'q1', 'req-q1');
    insertUsage(harness, 'q1', 'input', '400', 'planning', null);
    const q1 = harness.billService.finalizeQueryBill({
      queryId: 'q1', finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(q1.status).toBe('finalized');
    if (q1.status !== 'finalized') throw new Error('unreachable');
    expect(q1.bill.taskId).toBeNull();

    // Q2: the user supplies the material; the Kernel authorizes Task T1.
    beginQueryFor(harness, 'q2', 'req-q2');
    linkQueryTask(harness, 'q2', 'task-1');
    insertUsage(harness, 'q2', 'input', '1000', 'planning', 'task-1');
    insertUsage(harness, 'q2', 'input', '2000', 'execution', 'task-1', 'exec');
    const q2 = harness.billService.finalizeQueryBill({
      queryId: 'q2', finalizedAt: '2026-09-21T10:02:00.000Z',
    });
    expect(q2.status).toBe('finalized');
    if (q2.status !== 'finalized') throw new Error('unreachable');
    expect(q2.bill.taskId).toBe('task-1');

    // Q3: an explicit Resume is a new Query that continues the same Task.
    beginQueryFor(harness, 'q3', 'req-q3');
    linkQueryTask(harness, 'q3', 'task-1', 'authorized_execution_segment');
    insertUsage(harness, 'q3', 'input', '1000', 'execution', 'task-1');
    const q3 = harness.billService.finalizeQueryBill({
      queryId: 'q3', finalizedAt: '2026-09-21T10:03:00.000Z',
    });
    expect(q3.status).toBe('finalized');

    const service = createBillQueryService({
      bills: harness.bills,
      adjustments: harness.adjustments,
      consumption: harness.outbox,
    });
    const summary = service.getTaskUsageSummary('task-1');
    expect(summary.queryCount).toBe(2);
    expect(summary.finalizedMicroCoin).toBe(
      (BigInt(q2.bill.amountMicroCoin) + BigInt(
        harness.bills.findByQueryId('q3')!.amountMicroCoin,
      )).toString(),
    );
    // Q1 is not silently attached to T1.
    expect(harness.bills.listBillsForTask('task-1').map(bill => bill.queryId).sort())
      .toEqual(['q2', 'q3']);
    expect(q1.bill.taskId).toBeNull();
    expect(service.getUsageSummary('account-1').billCount).toBe(3);

    // External round trip: the first response is lost, the original key is queried.
    const server = createFakeConsumptionServer();
    let lossy = true;
    const lossyPort = {
      submitBill: async (bill: Parameters<typeof server.submitBill>[0]) => {
        const result = await server.submitBill(bill);
        if (lossy) {
          lossy = false;
          throw new Error('timeout after apply');
        }
        return result;
      },
      getBillStatus: (key: { sourceInstanceId: string; billId: string }) => server.getBillStatus(key),
    };
    const exportService = createConsumptionExportService({
      port: lossyPort,
      outbox: harness.outbox,
      exportEnabled: () => true,
      now: () => '2026-09-21T10:05:00.000Z',
    });
    const outcomes = await exportService.drainPending(10);
    expect(outcomes.every(outcome => outcome.status === 'settled')).toBe(true);
    for (const queryId of ['q1', 'q2', 'q3']) {
      const bill = harness.bills.findByQueryId(queryId)!;
      expect(harness.outbox.find(bill.billId)?.state).toBe('confirmed');
      expect(harness.outbox.latestReceipt(bill.billId)?.appliedAmountMicroCoin)
        .toBe(bill.amountMicroCoin);
    }
    // Exactly one applied consumption per bill; no Query was charged twice.
    expect(server.applied.size).toBe(3);
    expect(service.getUsageSummary('account-1').confirmedDeductedMicroCoin).toBe(
      ['q1', 'q2', 'q3']
        .map(queryId => BigInt(harness.bills.findByQueryId(queryId)!.amountMicroCoin))
        .reduce((sum, amount) => sum + amount, 0n)
        .toString(),
    );
    db.close();
  });
});

function harnessFor(db: Database.Database): BillingHarness {
  const contexts = new SqliteQueryContextStore(db);
  const metering = new SqliteMeteringStore(db, prefix => `${prefix}_${Math.random().toString(36).slice(2, 8)}`);
  const prices = new SqlitePriceStore(db);
  const costEntries = new SqliteCostEntryStore(db);
  const bills = new SqliteBillStore(db);
  const adjustments = new SqliteBillAdjustmentStore(db);
  const outbox = new SqliteConsumptionOutboxStore(db, prefix => `${prefix}_${Math.random().toString(36).slice(2, 8)}`);
  const unitOfWork = new SqliteBillingUnitOfWork(db);
  let exportEnabled = false;
  let externalAccountRef: string | null = null;
  outbox.ensureSourceInstanceId('instance-test', '2026-09-21T00:00:00.000Z');
  const billService = createQueryBillService({
    queryContexts: contexts,
    metering,
    prices,
    costEntries,
    bills,
    unitOfWork,
    consumption: outbox,
    exportEnabled: () => exportEnabled,
    resolveExternalAccountRef: () => externalAccountRef,
    createCostEntryId: (observationId, kind) => `cost_${kind}_${observationId}`,
  });
  return {
    db,
    contexts,
    metering,
    prices,
    costEntries,
    bills,
    adjustments,
    outbox,
    billService,
    setExportEnabled(enabled) {
      exportEnabled = enabled;
    },
    bindExternalAccountRef(ref) {
      externalAccountRef = ref;
    },
    externalAccountRef() {
      return externalAccountRef;
    },
    close() {
      db.close();
    },
  };
}

function beginQueryFor(harness: BillingHarness, queryId: string, requestKey: string): void {
  const service = createQueryContextService({
    store: harness.contexts,
    createQueryId: () => queryId,
  });
  const result = service.beginQuery({
    externalAccountRef: harness.externalAccountRef(),
    accountId: 'account-1',
    ingress: 'web',
    requestKey,
    requestPayloadDigest: `digest-${queryId}`,
    conversationId: 'conversation-1',
    requestId: `request-${queryId}`,
    priceBookVersion: PLATFORM_PRICE_BOOK.priceBookVersion,
    feePolicyVersion: PLATFORM_PRICE_BOOK.feePolicyVersion,
    payerPolicyVersion: PLATFORM_PRICE_BOOK.payerPolicyVersion,
    acceptedAt: '2026-09-21T10:00:00.000Z',
  });
  if (result.status === 'conflict') throw new Error('query context conflict');
}

function linkQueryTask(
  harness: BillingHarness,
  queryId: string,
  taskId: string,
  basis: 'authorized_application' | 'authorized_execution_segment' = 'authorized_application',
): void {
  const service = createQueryContextService({
    store: harness.contexts,
    createQueryId: () => queryId,
  });
  const outcome = service.bindCostTask({
    queryId,
    taskId,
    decisionId: `decision-${queryId}`,
    basis,
    linkedAt: '2026-09-21T10:00:10.000Z',
  });
  if (outcome.status === 'conflict') throw new Error('task link conflict');
}

function insertUsage(
  harness: BillingHarness,
  queryId: string,
  metric: 'input' | 'output',
  quantity: string,
  stage: 'planning' | 'execution',
  taskId: string | null,
  suffix = stage,
): void {
  harness.metering.insertObservations([{
    observationId: `obs_${queryId}_${suffix}_${metric}`,
    spanId: null,
    sourceId: 'planner',
    sourceEventKey: `evt_${queryId}_${suffix}_${metric}`,
    sourceScope: 'model_request',
    callId: `call_${queryId}_${suffix}_${metric}`,
    queryId,
    executionSegmentId: null,
    taskId,
    stage,
    reason: 'primary',
    resource: 'model_tokens',
    metric,
    unit: 'token',
    quantityNumerator: quantity,
    quantityDenominator: '1',
    quality: 'reported',
    countsTowardTotal: true,
    payer: 'platform',
    capturedAt: '2026-09-21T10:00:05.000Z',
    providerBindingVersion: null,
    evidenceRef: null,
    normalizationRuleVersion: 'usage-normalizer-v1',
  }]);
}

// ===== 可见账单真实链路验收（账单简化设计 §6/§8） =====
//
// 一次真实请求必须在数据库中同时看到 Query、usage observation、bill projection
// 或明确的 pending 诊断，并且当前 Turn 视图、账单页列表、Task 详情读到同一
// Server 投影；usage 缺失时页面拿到待确认与稳定诊断码，绝不静默空白。

describe('visible billing real-link acceptance', () => {
  function seedTurnContext(
    harness: BillingHarness,
    input: { readonly queryId: string; readonly turnId: string; readonly taskId?: string },
  ): void {
    harness.contexts.insert({
      queryId: input.queryId,
      accountId: 'account-1',
      ingress: 'web',
      requestKey: `req-${input.queryId}`,
      requestPayloadDigest: `digest-${input.queryId}`,
      conversationId: 'conversation-1',
      requestId: `request-${input.queryId}`,
      turnId: input.turnId,
      executionSegmentId: null,
      priceBookVersion: PLATFORM_PRICE_BOOK.priceBookVersion,
      feePolicyVersion: PLATFORM_PRICE_BOOK.feePolicyVersion,
      payerPolicyVersion: PLATFORM_PRICE_BOOK.payerPolicyVersion,
      acceptedAt: '2026-09-21T10:00:00.000Z',
    });
    if (input.taskId) linkQueryTask(harness, input.queryId, input.taskId);
  }

  function createVisibleProjection(harness: BillingHarness) {
    return createBillQueryService({
      bills: harness.bills,
      adjustments: harness.adjustments,
      consumption: harness.outbox,
      costs: harness.costEntries,
      queryContexts: harness.contexts,
      metering: harness.metering,
      prices: harness.prices,
      exportEnabled: () => false,
      now: () => '2026-09-22T00:00:00.000Z',
    });
  }

  it('one real request yields Query + usage + bill facts and one consistent three-state projection', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const harness = harnessFor(db);
    seedPriceBook(harness);
    seedTurnContext(harness, { queryId: 'q-live', turnId: 'turn-1', taskId: 'task-1' });

    // 计量事实：Pi message_end.usage / Codex turn.completed.usage 解析归因后的持久观测。
    insertUsage(harness, 'q-live', 'input', '1000', 'planning', 'task-1');
    insertUsage(harness, 'q-live', 'output', '2000', 'execution', 'task-1', 'exec');
    const finalized = harness.billService.finalizeQueryBill({
      queryId: 'q-live',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(finalized.status).toBe('finalized');

    // 数据库事实齐备：Query、usage observation、bill projection。
    expect(harness.contexts.findById('q-live')?.turnId).toBe('turn-1');
    expect(harness.metering.listObservations('q-live')).toHaveLength(2);
    const billRow = harness.bills.findByQueryId('q-live')!;
    expect(billRow.state).toBe('finalized');

    // Server 三端投影一致：当前 Turn、账单页、Task 详情。
    const projection = createVisibleProjection(harness);
    const turnView = projection.getTurnBillUserView('account-1', 'turn-1');
    expect(turnView?.userStatus).toBe('billed');
    expect(turnView?.amountMicroCoin)
      .toBe(formatDecimalUnits(BigInt(billRow.amountMicroCoin), 6));
    expect(turnView?.headline)
      .toBe(`本次费用：${formatDecimalUnits(BigInt(billRow.amountMicroCoin), 6)} MetaCoin`);
    const listPage = projection.listQueryBillsPage!({ accountId: 'account-1', limit: 20 });
    expect(listPage.items).toHaveLength(1);
    expect(listPage.items[0]!.queryId).toBe('q-live');
    expect(listPage.items[0]!.userStatus).toBe('billed');
    expect(listPage.items[0]!.turnId).toBe('turn-1');
    const taskItems = projection.listQueryBillsForTask('account-1', 'task-1');
    expect(taskItems).toHaveLength(1);
    expect(taskItems[0]!.userStatus).toBe('billed');
    db.close();
  });

  it('a request whose usage never arrives still yields an explicit pending diagnostic everywhere', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const harness = harnessFor(db);
    seedPriceBook(harness);
    seedTurnContext(harness, { queryId: 'q-silent', turnId: 'turn-2' });
    const outcome = harness.billService.finalizeQueryBill({
      queryId: 'q-silent',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(outcome.status).toBe('pending_reconciliation');

    const projection = createVisibleProjection(harness);
    const turnView = projection.getTurnBillUserView('account-1', 'turn-2');
    expect(turnView?.userStatus).toBe('unconfirmed');
    expect(turnView?.diagnosticCode).toBe('no_usage_observed');
    expect(turnView?.amountMicroCoin).toBeNull();
    expect(turnView?.observedUsageCount).toBe(0);
    const listPage = projection.listQueryBillsPage!({ accountId: 'account-1', limit: 20 });
    expect(listPage.items[0]!.diagnosticCode).toBe('no_usage_observed');
    expect(listPage.items[0]!.diagnosticMessage)
      .toBe('Provider 未返回可验证的用量数据');

    // 历史兜底：一个完全没有事实的 Turn 也不会静默空白。
    const historical = projection.getTurnBillUserView('account-1', 'turn-ancient');
    expect(historical?.userStatus).toBe('unconfirmed');
    expect(historical?.diagnosticCode).toBe('historical_unavailable');
    db.close();
  });

  it('late usage cannot silently change a finalized bill; the page keeps the original amount', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const harness = harnessFor(db);
    seedPriceBook(harness);
    seedTurnContext(harness, { queryId: 'q-final', turnId: 'turn-3' });
    insertUsage(harness, 'q-final', 'input', '1000', 'planning', null);
    harness.billService.finalizeQueryBill({
      queryId: 'q-final',
      finalizedAt: '2026-09-21T10:01:00.000Z',
    });
    const before = harness.bills.findByQueryId('q-final')!.amountMicroCoin;
    // 晚到的 usage：插入新观测后重复终结必须幂等，且金额不变。
    insertUsage(harness, 'q-final', 'input', '90000', 'planning', null, 'late');
    const repeat = harness.billService.finalizeQueryBill({
      queryId: 'q-final',
      finalizedAt: '2026-09-21T10:05:00.000Z',
    });
    expect(repeat.status).toBe('already_finalized');
    expect(harness.bills.findByQueryId('q-final')!.amountMicroCoin).toBe(before);
    expect(createVisibleProjection(harness).getTurnBillUserView('account-1', 'turn-3')?.amountMicroCoin)
      .toBe(formatDecimalUnits(BigInt(before), 6));
    db.close();
  });
});
