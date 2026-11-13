import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { SqliteMeteringStore } from '../storage/metering-repo.js';
import { SqliteQueryContextStore } from '../storage/query-usage-context-repo.js';
import { createQueryContextService } from '../metering/query-context-service.js';
import type { QueryUsageLifecycle } from '../metering/query-lifecycle.js';
import { TokenUsageService } from '../metering/token-usage-service.js';

export interface ServerMeteringServices {
  readonly lifecycle: QueryUsageLifecycle;
  readonly contexts: SqliteQueryContextStore;
  readonly metering: SqliteMeteringStore;
  readonly tokenUsage: TokenUsageService;
}

/** Server-owned attribution and Token accounting. Never creates monetary facts. */
export function createServerMeteringServices(db: Database.Database): ServerMeteringServices {
  const contexts = new SqliteQueryContextStore(db);
  const metering = new SqliteMeteringStore(db);
  const tokenUsage = new TokenUsageService(metering);
  const queryContext = createQueryContextService({
    store: contexts,
    createQueryId: () => `query_${randomUUID()}`,
  });
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
          // Query admission precedes model selection. This lifecycle span is
          // not evidence of a Provider call and cannot inherit a deployment
          // default; actual observations carry the pinned call ownership.
          payer: 'unknown',
          startedAt: result.context.acceptedAt,
          closedAt: null,
        });
      }
      return result;
    },
    bindTask(input) {
      return queryContext.bindTask(input);
    },
    getTaskId(queryId) {
      return contexts.findTaskLink(queryId)?.taskId ?? null;
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
    },
  };
  return { lifecycle, contexts, metering, tokenUsage };
}
