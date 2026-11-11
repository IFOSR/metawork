import type Database from 'better-sqlite3';
import { createDatabase } from '../../src/storage/database.js';
import { createServerMeteringServices, type ServerMeteringServices } from '../../src/server/metering-composition.js';
import { createQueryContextService } from '../../src/metering/query-context-service.js';
import { rational } from '../../src/metering/quantity.js';
import { exactQuantityFromRational } from '../../src/metering/contracts.js';
import type { PersistedUsageObservation } from '../../src/metering/ports.js';

export interface MeteringHarness extends ServerMeteringServices {
  readonly db: Database.Database;
  close(): void;
}

export function createMeteringHarness(): MeteringHarness {
  const db = createDatabase(':memory:');
  return { db, ...createServerMeteringServices(db), close() { db.close(); } };
}

/** 建立 Query 归因上下文；不需要价格或账单。 */
export function beginQuery(
  harness: MeteringHarness,
  input: {
    readonly queryId: string;
    readonly requestKey?: string;
    readonly requestId?: string;
    readonly conversationId?: string | null;
    readonly accountId?: string;
    readonly payloadDigest?: string;
  },
): void {
  const service = createQueryContextService({
    store: harness.contexts,
    createQueryId: () => input.queryId,
  });
  const result = service.beginQuery({
    accountId: input.accountId ?? 'account-1',
    ingress: 'web',
    requestKey: input.requestKey ?? `req-${input.queryId}`,
    requestPayloadDigest: input.payloadDigest ?? `digest-${input.queryId}`,
    conversationId: input.conversationId ?? 'conversation-1',
    requestId: input.requestId ?? `request-${input.queryId}`,
    turnId: null,
    acceptedAt: '2026-09-21T10:00:00.000Z',
  });
  if (result.status === 'conflict') throw new Error('query context conflict in test setup');
}

export function insertObservation(
  harness: MeteringHarness,
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

export function linkTask(harness: MeteringHarness, queryId: string, taskId: string): void {
  const service = createQueryContextService({
    store: harness.contexts,
    createQueryId: () => queryId,
  });
  const outcome = service.bindTask({
    queryId,
    taskId,
    decisionId: `decision_${queryId}`,
    basis: 'authorized_application',
    linkedAt: '2026-09-21T10:00:10.000Z',
  });
  if (outcome.status === 'conflict') throw new Error('task link conflict in test setup');
}

export { rational, exactQuantityFromRational };
