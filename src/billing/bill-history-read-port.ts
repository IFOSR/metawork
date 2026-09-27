import type {
  BillAdjustmentPort, BillAdjustmentRecord, BillStorePort, ConsumptionOutboxPort,
  ConsumptionOutboxRecord, ConsumptionReceiptRecord, CostEntryPort, CostEntryRecord,
  PriceStorePort, QueryBillLineRecord, QueryBillRecord,
} from './ports.js';
import type { PriceBookVersion } from './pricing.js';
import type {
  MeteringSpanRecord, MeteringStore, PersistedUsageObservation, QueryContextStore,
  QueryTaskLink, QueryUsageContext,
} from '../metering/ports.js';

export interface BillQueryReadPorts {
  readonly bills: Pick<BillStorePort,
    'findByQueryId' | 'listLines' | 'listBillsForTask' | 'listBillsForAccount' | 'listBillsForAccountPage'>;
  readonly adjustments: Pick<BillAdjustmentPort, 'listForBill'>;
  readonly consumption: Pick<ConsumptionOutboxPort, 'find' | 'latestReceipt'>;
  readonly costs?: Pick<CostEntryPort, 'listForQuery'>;
  readonly queryContexts?: Pick<QueryContextStore, 'findById' | 'findByTurnId' | 'findTaskLink'>;
  readonly metering?: Pick<MeteringStore, 'listObservations' | 'listSpans'>;
  readonly prices?: Pick<PriceStorePort, 'find'>;
}

export interface BillHistoryReadPort {
  read(accountId: string, turnIds: readonly string[], taskIds: readonly string[]): BillQueryReadPorts;
}

/** Set reads only. The adapter supplies one consistent, read-only snapshot boundary. */
export interface BillHistorySources {
  readSnapshot<T>(read: () => T): T;
  readonly contexts: {
    findForTurns(accountId: string, turnIds: readonly string[]): QueryUsageContext[];
    findByIds(queryIds: readonly string[]): QueryUsageContext[];
    findTaskLinks(queryIds: readonly string[]): QueryTaskLink[];
  };
  readonly bills: {
    findForHistory(queryIds: readonly string[], taskIds: readonly string[]): QueryBillRecord[];
    listLinesForBills(billIds: readonly string[]): QueryBillLineRecord[];
  };
  readonly metering: {
    listObservationsForQueries(queryIds: readonly string[]): PersistedUsageObservation[];
    listSpansForQueries(queryIds: readonly string[]): MeteringSpanRecord[];
  };
  readonly costs: { listForQueries(queryIds: readonly string[]): CostEntryRecord[] };
  readonly prices: { findVersions(versions: readonly string[]): PriceBookVersion[] };
  readonly consumption: {
    findForBills(billIds: readonly string[]): ConsumptionOutboxRecord[];
    latestReceiptsForBills(billIds: readonly string[]): ConsumptionReceiptRecord[];
  };
  readonly adjustments: { listForBills(billIds: readonly string[]): BillAdjustmentRecord[] };
}

function index<T>(rows: readonly T[], key: (row: T) => string): ReadonlyMap<string, T> {
  return new Map(rows.map(row => [key(row), row]));
}

function group<T>(rows: readonly T[], key: (row: T) => string): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const items = grouped.get(id);
    if (items) items.push(row);
    else grouped.set(id, [row]);
  }
  return grouped;
}

function outsideScope(): never {
  throw new Error('billing_history_scope');
}

export function createBillHistoryReader(sources: BillHistorySources): BillHistoryReadPort {
  return {
    read(accountId, turnIds, taskIds) {
      if (turnIds.length > 100) throw new Error('history_turn_limit');
      if (taskIds.length > 100) throw new Error('history_task_limit');
      return sources.readSnapshot(() => {
        const turns = new Set(turnIds);
        const tasks = new Set(taskIds);
        const turnContexts = sources.contexts.findForTurns(accountId, [...turns]);
        const pageQueryIds = turnContexts.map(row => row.queryId);
        // Keep foreign bill ownership facts: filtering them would authorize mixed-account Tasks.
        const bills = sources.bills.findForHistory(pageQueryIds, [...tasks]);
        const queryIds = [...new Set([...pageQueryIds, ...bills.map(row => row.queryId)])];
        const contexts = sources.contexts.findByIds(queryIds);
        const billIds = bills.map(row => row.billId);
        const byTurn = index(turnContexts, row => row.turnId!);
        const byQuery = index(contexts, row => row.queryId);
        const links = index(sources.contexts.findTaskLinks(queryIds), row => row.queryId);
        const billsByQuery = index(bills, row => row.queryId);
        const billsByTask = group(bills, row => row.taskId ?? '');
        const lines = group(sources.bills.listLinesForBills(billIds), row => row.billId);
        const observations = group(sources.metering.listObservationsForQueries(queryIds), row => row.queryId);
        const spans = group(sources.metering.listSpansForQueries(queryIds), row => row.queryId);
        const costs = group(sources.costs.listForQueries(queryIds), row => row.queryId);
        const prices = index(sources.prices.findVersions(
          [...new Set(contexts.map(row => row.priceBookVersion))],
        ), row => row.priceBookVersion);
        const outbox = index(sources.consumption.findForBills(billIds), row => row.billId);
        const receipts = index(sources.consumption.latestReceiptsForBills(billIds), row => row.billId);
        const adjustments = group(sources.adjustments.listForBills(billIds), row => row.billId);
        return {
          bills: {
            findByQueryId: id => billsByQuery.get(id) ?? null,
            listLines: id => [...(lines.get(id) ?? [])],
            listBillsForTask: id => tasks.has(id) ? [...(billsByTask.get(id) ?? [])] : outsideScope(),
            listBillsForAccount: outsideScope,
            listBillsForAccountPage: outsideScope,
          },
          queryContexts: {
            findById: id => byQuery.get(id) ?? null,
            findByTurnId: (account, id) => {
              if (account !== accountId || !turns.has(id)) return outsideScope();
              return byTurn.get(id) ?? null;
            },
            findTaskLink: id => links.get(id) ?? null,
          },
          metering: {
            listObservations: id => [...(observations.get(id) ?? [])],
            listSpans: id => [...(spans.get(id) ?? [])],
          },
          costs: { listForQuery: id => [...(costs.get(id) ?? [])] },
          prices: { find: id => prices.get(id) ?? null },
          consumption: {
            find: id => outbox.get(id) ?? null,
            latestReceipt: id => receipts.get(id) ?? null,
          },
          adjustments: { listForBill: id => [...(adjustments.get(id) ?? [])] },
        };
      });
    },
  };
}
