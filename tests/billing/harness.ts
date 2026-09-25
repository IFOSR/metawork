import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteQueryContextStore } from '../../src/storage/query-usage-context-repo.js';
import { SqliteMeteringStore } from '../../src/storage/metering-repo.js';
import {
  SqliteBillAdjustmentStore,
  SqliteBillStore,
  SqliteBillingUnitOfWork,
  SqliteCostEntryStore,
  SqlitePriceStore,
} from '../../src/storage/billing-repo.js';
import { SqliteConsumptionOutboxStore } from '../../src/storage/consumption-outbox-repo.js';
import { createQueryBillService, type QueryBillService } from '../../src/billing/query-bill-service.js';
import { createQueryContextService } from '../../src/metering/query-context-service.js';
import { rational } from '../../src/billing/money.js';
import { createPriceBookVersion } from '../../src/billing/pricing.js';
import { exactQuantityFromRational } from '../../src/metering/contracts.js';
import type { PersistedUsageObservation } from '../../src/metering/ports.js';

export interface BillingHarness {
  readonly db: Database.Database;
  readonly contexts: SqliteQueryContextStore;
  readonly metering: SqliteMeteringStore;
  readonly prices: SqlitePriceStore;
  readonly costEntries: SqliteCostEntryStore;
  readonly bills: SqliteBillStore;
  readonly adjustments: SqliteBillAdjustmentStore;
  readonly outbox: SqliteConsumptionOutboxStore;
  readonly billService: QueryBillService;
  setExportEnabled(enabled: boolean): void;
  bindExternalAccountRef(ref: string | null): void;
  externalAccountRef(): string | null;
  close(): void;
}

export const PLATFORM_PRICE_BOOK = {
  priceBookVersion: 'pb-test',
  feePolicyVersion: 'fp-test',
  payerPolicyVersion: 'pp-test',
  markupBps: 4000n,
  effectiveFrom: '2026-09-01T00:00:00.000Z',
};

export function createBillingHarness(options: {
  readonly exportEnabled?: boolean;
  readonly externalAccountRef?: string | null;
} = {}): BillingHarness {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const contexts = new SqliteQueryContextStore(db);
  const metering = new SqliteMeteringStore(db, prefix => `${prefix}_${Math.random().toString(36).slice(2, 10)}`);
  const prices = new SqlitePriceStore(db);
  const costEntries = new SqliteCostEntryStore(db);
  const bills = new SqliteBillStore(db);
  const adjustments = new SqliteBillAdjustmentStore(db);
  const outbox = new SqliteConsumptionOutboxStore(db, prefix => `${prefix}_${Math.random().toString(36).slice(2, 10)}`);
  const unitOfWork = new SqliteBillingUnitOfWork(db);

  let exportEnabled = options.exportEnabled ?? false;
  let externalAccountRef: string | null = options.externalAccountRef ?? null;
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
    externalAccountRef: () => externalAccountRef,
    close() {
      db.close();
    },
  };
}

export function seedPriceBook(
  harness: BillingHarness,
  units: Array<{ resource: string; metric: string; nanoCnyPerUnit: { numerator: string; denominator: string } }> = [
    { resource: 'model_tokens', metric: 'input', nanoCnyPerUnit: { numerator: '20', denominator: '1' } },
    { resource: 'model_tokens', metric: 'output', nanoCnyPerUnit: { numerator: '60', denominator: '1' } },
    { resource: 'compute', metric: 'cpu_second', nanoCnyPerUnit: { numerator: '500', denominator: '1' } },
  ],
  priceBookVersion: string = PLATFORM_PRICE_BOOK.priceBookVersion,
): void {
  harness.prices.insert(createPriceBookVersion({
    ...PLATFORM_PRICE_BOOK,
    priceBookVersion,
    units: units.map(unit => ({
      resource: unit.resource as never,
      metric: unit.metric,
      nanoCnyPerUnit: rational(
        BigInt(unit.nanoCnyPerUnit.numerator),
        BigInt(unit.nanoCnyPerUnit.denominator),
      ),
    })),
  }), '2026-09-01T00:00:00.000Z');
}

/** 建立 Query 归因上下文；默认使用平台默认价格版本。 */
export function beginQuery(
  harness: BillingHarness,
  input: {
    readonly queryId: string;
    readonly requestKey?: string;
    readonly requestId?: string;
    readonly conversationId?: string | null;
    readonly accountId?: string;
    readonly priceBookVersion?: string;
    readonly payerPolicyVersion?: string;
    readonly payloadDigest?: string;
  },
): void {
  const service = createQueryContextService({
    store: harness.contexts,
    createQueryId: () => input.queryId,
  });
  const result = service.beginQuery({
    externalAccountRef: harness.externalAccountRef(),
    accountId: input.accountId ?? 'account-1',
    ingress: 'web',
    requestKey: input.requestKey ?? `req-${input.queryId}`,
    requestPayloadDigest: input.payloadDigest ?? `digest-${input.queryId}`,
    conversationId: input.conversationId ?? 'conversation-1',
    requestId: input.requestId ?? `request-${input.queryId}`,
    turnId: null,
    priceBookVersion: input.priceBookVersion ?? PLATFORM_PRICE_BOOK.priceBookVersion,
    feePolicyVersion: PLATFORM_PRICE_BOOK.feePolicyVersion,
    payerPolicyVersion: input.payerPolicyVersion ?? PLATFORM_PRICE_BOOK.payerPolicyVersion,
    acceptedAt: '2026-09-21T10:00:00.000Z',
  });
  if (result.status === 'conflict') throw new Error('query context conflict in test setup');
}

export function insertObservation(
  harness: BillingHarness,
  input: {
    readonly queryId: string;
    readonly metric: string;
    readonly quantity: string;
    readonly resource?: PersistedUsageObservation['resource'];
    readonly unit?: string;
    readonly stage?: PersistedUsageObservation['stage'];
    readonly payer?: PersistedUsageObservation['payer'];
    readonly agentClassRef?: string | null;
    readonly providerRef?: string | null;
    readonly modelId?: string | null;
    readonly quality?: PersistedUsageObservation['quality'];
    readonly countsTowardTotal?: boolean;
    readonly taskId?: string | null;
    readonly suffix?: string;
    readonly sourceId?: string;
  },
): void {
  const suffix = input.suffix ?? input.metric;
  harness.metering.insertObservations([{
    observationId: `obs_${input.queryId}_${suffix}`,
    spanId: null,
    sourceId: input.sourceId ?? 'planner',
    sourceEventKey: `evt_${input.queryId}_${suffix}`,
    sourceScope: 'model_request',
    callId: `call_${input.queryId}_${suffix}`,
    queryId: input.queryId,
    executionSegmentId: null,
    taskId: input.taskId ?? null,
    stage: input.stage ?? 'planning',
    reason: 'primary',
    resource: input.resource ?? 'model_tokens',
    metric: input.metric,
    unit: input.unit ?? 'token',
    quantityNumerator: input.quantity,
    quantityDenominator: '1',
    quality: input.quality ?? 'reported',
    countsTowardTotal: input.countsTowardTotal ?? true,
      payer: input.payer ?? 'platform',
      agentClassRef: input.agentClassRef ?? null,
      providerRef: input.providerRef ?? null,
      modelId: input.modelId ?? null,
    capturedAt: '2026-09-21T10:00:05.000Z',
    providerBindingVersion: null,
    evidenceRef: null,
    normalizationRuleVersion: 'usage-normalizer-v1',
  }]);
}

export function linkTask(harness: BillingHarness, queryId: string, taskId: string): void {
  const service = createQueryContextService({
    store: harness.contexts,
    createQueryId: () => queryId,
  });
  const outcome = service.bindCostTask({
    queryId,
    taskId,
    decisionId: `decision_${queryId}`,
    basis: 'authorized_application',
    linkedAt: '2026-09-21T10:00:10.000Z',
  });
  if (outcome.status === 'conflict') throw new Error('task link conflict in test setup');
}

export { rational, exactQuantityFromRational };
