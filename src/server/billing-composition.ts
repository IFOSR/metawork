import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createQueryBillService, type QueryBillService } from '../billing/query-bill-service.js';
import { createBillQueryService, type BillQueryService } from '../billing/bill-query-service.js';
import { SqliteConsumptionOutboxStore } from '../storage/consumption-outbox-repo.js';
import {
  SqliteBillAdjustmentStore,
  SqliteBillStore,
  SqliteBillingUnitOfWork,
  SqliteCostEntryStore,
  SqlitePriceStore,
} from '../storage/billing-repo.js';
import { SqliteMeteringStore } from '../storage/metering-repo.js';
import { SqliteQueryContextStore } from '../storage/query-usage-context-repo.js';
import { createQueryContextService } from '../metering/query-context-service.js';
import type { QueryUsageLifecycle } from '../metering/query-lifecycle.js';
import { createPriceBookVersion } from '../billing/pricing.js';
import { rational } from '../billing/money.js';
import { isPayer, type Payer } from '../billing/cost-policy.js';
import {
  buildConfiguredPriceBook,
  type BillingModelPriceInput,
} from '../billing/configured-price-book.js';

export interface ServerBillingServices {
  readonly lifecycle: QueryUsageLifecycle;
  readonly queries: BillQueryService;
  readonly billService: QueryBillService;
  readonly contexts: SqliteQueryContextStore;
  readonly metering: SqliteMeteringStore;
  readonly priceBookVersion: string;
  readonly feePolicyVersion: string;
  readonly payerPolicyVersion: string;
  readonly externalAccountRef: string | null;
  /** Re-attempts only non-finalized bills; finalized history is immutable. */
  readonly reconcilePendingBills: (accountId: string, finalizedAt: string) => number;
  readonly refreshConfiguration: (input: {
    readonly configurationRevision: string;
    readonly models: readonly BillingModelPriceInput[];
  }) => void;
}

export const DEFAULT_PAYER_POLICY_VERSION = 'platform-default-v1';

export function resolveConfiguredUsagePayer(
  env: NodeJS.ProcessEnv = process.env,
): Payer {
  const configured = env.METAWORK_BILLING_DEFAULT_PAYER?.trim();
  return configured && isPayer(configured) ? configured : 'platform';
}

export function billingModelPriceInputs(
  models: Iterable<{
    readonly providerRef: string;
    readonly modelId: string;
    readonly costInputPerMillion?: number;
    readonly costOutputPerMillion?: number;
  }>,
): BillingModelPriceInput[] {
  return [...models].map(model => ({
    providerRef: model.providerRef,
    modelId: model.modelId,
    costInputPerMillion: model.costInputPerMillion,
    costOutputPerMillion: model.costOutputPerMillion,
  }));
}

/**
 * Server-owned billing wiring. No client value participates in price, payer or
 * external-account selection. Missing deployment inputs deliberately leave
 * bills in observe/shadow mode instead of inventing a price.
 */
export function createServerBillingServices(
  db: Database.Database,
  options: {
    readonly configurationRevision?: string;
    readonly models?: readonly BillingModelPriceInput[];
  } = {},
  env: NodeJS.ProcessEnv = process.env,
): ServerBillingServices {
  const contexts = new SqliteQueryContextStore(db);
  const metering = new SqliteMeteringStore(db);
  const prices = new SqlitePriceStore(db);
  const costEntries = new SqliteCostEntryStore(db);
  const bills = new SqliteBillStore(db);
  const adjustments = new SqliteBillAdjustmentStore(db);
  const outbox = new SqliteConsumptionOutboxStore(db);
  const unitOfWork = new SqliteBillingUnitOfWork(db);
  const sourceInstanceId = env.METAWORK_BILLING_SOURCE_INSTANCE_ID?.trim()
    || `instance_${randomUUID()}`;
  outbox.ensureSourceInstanceId(sourceInstanceId, new Date().toISOString());

  let configuredPriceBook = options.configurationRevision && options.models
    ? buildConfiguredPriceBookForConfiguration(options.configurationRevision, options.models, env)
    : null;
  const explicitPriceBook = parsePriceBookJson(env.METAWORK_BILLING_PRICE_BOOK_JSON);
  let priceBookVersion = resolvePriceBookVersion(env, explicitPriceBook, configuredPriceBook);
  let feePolicyVersion = resolveFeePolicyVersion(env, explicitPriceBook, configuredPriceBook);
  const payerPolicyVersion = env.METAWORK_BILLING_PAYER_POLICY_VERSION?.trim()
    || DEFAULT_PAYER_POLICY_VERSION;
  const configuredUsagePayer = resolveConfiguredUsagePayer(env);
  const externalAccountRef = env.METAWORK_EXTERNAL_ACCOUNT_REF?.trim() || null;
  const exportEnabled = env.METAWORK_BILLING_MODE === 'export' && externalAccountRef !== null;

  loadConfiguredPriceBook(prices, explicitPriceBook ?? configuredPriceBook);
  const queryContext = createQueryContextService({
    store: contexts,
    createQueryId: () => `query_${randomUUID()}`,
  });
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
  const reconcilePendingBills = (accountId: string, finalizedAt: string): number => {
    let finalized = 0;
    for (const bill of bills.listBillsForAccount(accountId)) {
      if (bill.state !== 'pending_reconciliation') continue;
      try {
        const result = billService.finalizeQueryBill({
          queryId: bill.queryId,
          finalizedAt,
        });
        if (result.status === 'finalized') finalized += 1;
      } catch (error) {
        console.warn(
          `[billing] pending bill reconciliation failed for ${bill.billId}: ${(error as Error).message}`,
        );
      }
    }
    return finalized;
  };
  const plannerSpanId = (queryId: string) => `span_planner_${queryId}`;
  const lifecycle: QueryUsageLifecycle = {
    beginQuery(input) {
      const result = queryContext.beginQuery(input);
      if (result.status === 'created') {
        metering.openSpan({
          spanId: plannerSpanId(result.context.queryId),
          queryId: result.context.queryId,
          executionSegmentId: result.context.executionSegmentId,
          sourceId: 'planner',
          sourceScope: 'model_request',
          callId: `planner:${result.context.queryId}`,
          stage: 'planning',
          reason: 'primary',
          state: 'started',
          payer: configuredUsagePayer,
          startedAt: result.context.acceptedAt,
          closedAt: null,
        });
      }
      return result;
    },
    bindCostTask(input) {
      return queryContext.bindCostTask(input);
    },
    getCostTaskId(queryId) {
      return contexts.findTaskLink(queryId)?.costTaskId ?? null;
    },
    finalizeQueriesForTask(taskId, finalizedAt) {
      for (const queryId of contexts.listQueryIdsForTask(taskId)) {
        lifecycle.finalizeQuery({ queryId, finalizedAt });
      }
    },
    finalizeQuery(input) {
      metering.closeSpan(
        plannerSpanId(input.queryId),
        'closed',
        input.finalizedAt,
      );
      billService.finalizeQueryBill(input);
    },
  };
  const services: ServerBillingServices = {
    lifecycle,
    queries: createBillQueryService({
      bills,
      adjustments,
      consumption: outbox,
      costs: costEntries,
      queryContexts: contexts,
      metering,
      prices,
      exportEnabled: () => exportEnabled,
    }),
    billService,
    contexts,
    metering,
    get priceBookVersion() {
      return priceBookVersion;
    },
    get feePolicyVersion() {
      return feePolicyVersion;
    },
    payerPolicyVersion,
    externalAccountRef,
    reconcilePendingBills,
    refreshConfiguration(input) {
      configuredPriceBook = buildConfiguredPriceBookForConfiguration(
        input.configurationRevision,
        input.models,
        env,
      );
      loadConfiguredPriceBook(prices, configuredPriceBook);
      priceBookVersion = resolvePriceBookVersion(env, explicitPriceBook, configuredPriceBook);
      feePolicyVersion = resolveFeePolicyVersion(env, explicitPriceBook, configuredPriceBook);
    },
  };
  return services;
}

function buildConfiguredPriceBookForConfiguration(
  configurationRevision: string,
  models: readonly BillingModelPriceInput[],
  env: NodeJS.ProcessEnv,
): ReturnType<typeof buildConfiguredPriceBook> {
  return buildConfiguredPriceBook({
    configurationRevision,
    models,
    markupBps: parseMarkupBps(env.METAWORK_BILLING_MARKUP_BPS),
    ...(env.METAWORK_BILLING_FEE_POLICY_VERSION?.trim()
      ? { feePolicyVersion: env.METAWORK_BILLING_FEE_POLICY_VERSION.trim() }
      : {}),
  });
}

function resolvePriceBookVersion(
  env: NodeJS.ProcessEnv,
  explicitPriceBook: ReturnType<typeof createPriceBookVersion> | null,
  configuredPriceBook: ReturnType<typeof buildConfiguredPriceBook>,
): string {
  return env.METAWORK_BILLING_PRICE_BOOK_VERSION?.trim()
    || explicitPriceBook?.priceBookVersion
    || configuredPriceBook?.priceBookVersion
    || 'unconfigured';
}

function resolveFeePolicyVersion(
  env: NodeJS.ProcessEnv,
  explicitPriceBook: ReturnType<typeof createPriceBookVersion> | null,
  configuredPriceBook: ReturnType<typeof buildConfiguredPriceBook>,
): string {
  return env.METAWORK_BILLING_FEE_POLICY_VERSION?.trim()
    || explicitPriceBook?.feePolicyVersion
    || configuredPriceBook?.feePolicyVersion
    || 'unconfigured';
}

function loadConfiguredPriceBook(
  prices: SqlitePriceStore,
  fallback: ReturnType<typeof buildConfiguredPriceBook>,
): void {
  if (!fallback) return;
  if (!prices.find(fallback.priceBookVersion)) prices.insert(fallback, new Date().toISOString());
}

function parsePriceBookJson(rawValue: string | undefined): ReturnType<typeof createPriceBookVersion> | null {
  const raw = rawValue?.trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw) as {
    priceBookVersion: string;
    feePolicyVersion: string;
    markupBps: string;
    effectiveFrom: string;
    units: Array<{
      resource: string;
      metric: string;
      agentClassRef?: string;
      providerRef?: string;
      modelId?: string;
      sourceCurrency?: string;
      numerator: string;
      denominator: string;
    }>;
  };
  const book = createPriceBookVersion({
    priceBookVersion: parsed.priceBookVersion,
    feePolicyVersion: parsed.feePolicyVersion,
    markupBps: BigInt(parsed.markupBps),
    effectiveFrom: parsed.effectiveFrom,
    units: parsed.units.map(unit => ({
      resource: unit.resource as never,
      metric: unit.metric,
      ...(unit.agentClassRef ? { agentClassRef: unit.agentClassRef } : {}),
      ...(unit.providerRef ? { providerRef: unit.providerRef } : {}),
      ...(unit.modelId ? { modelId: unit.modelId } : {}),
      ...(unit.sourceCurrency ? { sourceCurrency: unit.sourceCurrency } : {}),
      nanoCnyPerUnit: rational(BigInt(unit.numerator), BigInt(unit.denominator)),
    })),
  });
  return book;
}

function parseMarkupBps(value: string | undefined): bigint {
  const trimmed = value?.trim();
  if (!trimmed) return 4000n;
  if (!/^\d+$/u.test(trimmed)) throw new Error('invalid_billing_markup_bps');
  return BigInt(trimmed);
}
