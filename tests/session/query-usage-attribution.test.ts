import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteQueryContextStore } from '../../src/storage/query-usage-context-repo.js';
import { SqliteMeteringStore } from '../../src/storage/metering-repo.js';
import { createQueryContextService } from '../../src/metering/query-context-service.js';
import { normalizeUsageEvents } from '../../src/metering/usage-normalizer.js';
import { createUsageRecorder } from '../../src/metering/usage-service.js';

let db: Database.Database;
let store: SqliteQueryContextStore;
let metering: SqliteMeteringStore;
let ids: number;
let service: ReturnType<typeof createQueryContextService>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  store = new SqliteQueryContextStore(db);
  metering = new SqliteMeteringStore(db, prefix => `${prefix}_${ids++}`);
  ids = 0;
  service = createQueryContextService({ store, createQueryId: () => `query_${ids++}` });
});

afterEach(() => {
  db.close();
});

function begin(overrides: Partial<Parameters<typeof service.beginQuery>[0]> = {}) {
  return service.beginQuery({
    accountId: 'account-1',
    ingress: 'web',
    requestKey: 'req-1',
    requestPayloadDigest: 'digest-1',
    conversationId: 'conversation-1',
    requestId: 'request-1',
    turnId: 'turn-1',
    priceBookVersion: 'pb-1',
    feePolicyVersion: 'fp-1',
    payerPolicyVersion: 'pp-1',
    acceptedAt: '2026-09-21T10:00:00.000Z',
    ...overrides,
  });
}

describe('Query attribution', () => {
  it('persists a Query before the first chargeable call and links the Task only from an authorized application', () => {
    const created = begin();
    expect(created.status).toBe('created');
    if (created.status === 'conflict') throw new Error('unreachable');
    const queryId = created.context.queryId;
    expect(service.resolveAttribution(queryId).costTaskId).toBeNull();

    const linked = service.bindCostTask({
      queryId,
      taskId: 'task-1',
      decisionId: 'decision-1',
      basis: 'authorized_application',
      linkedAt: '2026-09-21T10:00:05.000Z',
    });
    expect(linked.status).toBe('linked');
    expect(service.resolveAttribution(queryId).costTaskId).toBe('task-1');
    expect(store.listQueryIdsForTask('task-1')).toEqual([queryId]);
  });

  it('keeps a clarification Query without a Task and still accrues planner cost', () => {
    const created = begin();
    if (created.status === 'conflict') throw new Error('unreachable');
    const queryId = created.context.queryId;
    metering.openSpan({
      spanId: 'span-clarify',
      queryId,
      executionSegmentId: null,
      sourceId: 'planner',
      sourceScope: 'model_request',
      callId: 'call-clarify',
      stage: 'planning',
      reason: 'primary',
      state: 'started',
      payer: 'platform',
      startedAt: '2026-09-21T10:00:01.000Z',
      closedAt: null,
    });
    const normalized = normalizeUsageEvents({
      events: [{
        sourceId: 'planner',
        sourceEventKey: 'evt-clarify',
        sourceScope: 'model_request',
        callId: 'call-clarify',
        queryId,
        stage: 'planning',
        payer: 'platform',
        capturedAt: '2026-09-21T10:00:02.000Z',
        counters: [{
          resource: 'model_tokens', metric: 'input', unit: 'token', kind: 'delta', value: '500',
        }],
      }],
    });
    expect(normalized.issues).toEqual([]);
    expect(metering.insertObservations(normalized.observations.map(observation => ({
      observationId: observation.observationId,
      spanId: 'span-clarify',
      sourceId: observation.sourceId,
      sourceEventKey: observation.sourceEventKey,
      sourceScope: observation.sourceScope,
      callId: observation.callId,
      queryId: observation.queryId,
      executionSegmentId: observation.executionSegmentId,
      taskId: observation.taskId,
      stage: observation.stage,
      reason: observation.reason,
      resource: observation.resource,
      metric: observation.metric,
      unit: observation.unit,
      quantityNumerator: observation.quantity.numerator,
      quantityDenominator: observation.quantity.denominator,
      quality: observation.quality,
      countsTowardTotal: observation.countsTowardTotal,
      payer: observation.payer,
      capturedAt: observation.capturedAt,
      providerBindingVersion: observation.providerBindingVersion,
      evidenceRef: observation.evidenceRef,
      normalizationRuleVersion: observation.normalizationRuleVersion,
    })))).toBe(1);
    // Cost exists, but the Query has no Task: Taskless billing is first-class.
    expect(metering.listObservations(queryId)).toHaveLength(1);
    expect(service.resolveAttribution(queryId).costTaskId).toBeNull();
  });

  it('does not globally deduplicate the same Planner turn fallback across Queries', () => {
    const first = begin({ requestKey: 'planner-query-1' });
    const second = begin({
      requestKey: 'planner-query-2',
      requestId: 'request-2',
      requestPayloadDigest: 'digest-2',
    });
    if (first.status === 'conflict' || second.status === 'conflict') {
      throw new Error('unexpected conflict');
    }
    const recorder = createUsageRecorder({ metering });
    const recordPlannerTurn = (queryId: string) => recorder.record({
      sourceId: 'planner',
      sourceEventKey: `${queryId}:message_end:planner-turn-1`,
      sourceScope: 'model_request',
      callId: `${queryId}:planner-turn-1`,
      queryId,
      stage: 'planning',
      payer: 'platform',
      capturedAt: '2026-09-21T10:00:02.000Z',
      providerRef: 'deepseek',
      modelId: 'deepseek-flash',
      counters: [{
        resource: 'model_tokens',
        metric: 'input',
        unit: 'token',
        kind: 'delta',
        value: '100',
      }],
    });

    expect(recordPlannerTurn(first.context.queryId)).toBe(1);
    expect(recordPlannerTurn(second.context.queryId)).toBe(1);
    expect(metering.listObservations(first.context.queryId)).toHaveLength(1);
    expect(metering.listObservations(second.context.queryId)).toHaveLength(1);
  });

  it('retains the Query and its observations on planning failure without a Task', () => {
    const created = begin({ requestKey: 'req-planning-failure' });
    if (created.status === 'conflict') throw new Error('unreachable');
    expect(created.context.queryId).toBeDefined();
    expect(store.listQueryIdsForTask('task-none')).toEqual([]);
  });

  it('gives an explanation request its own Query and does not rebind the original Task', () => {
    const first = begin({ requestKey: 'req-1' });
    if (first.status === 'conflict') throw new Error('unreachable');
    service.bindCostTask({
      queryId: first.context.queryId,
      taskId: 'task-1',
      decisionId: 'decision-1',
      basis: 'authorized_application',
      linkedAt: '2026-09-21T10:00:05.000Z',
    });
    const explanation = begin({
      requestKey: 'req-2',
      requestId: 'request-2',
      requestPayloadDigest: 'digest-2',
      acceptedAt: '2026-09-21T10:05:00.000Z',
    });
    if (explanation.status === 'conflict') throw new Error('unreachable');
    expect(explanation.context.queryId).not.toBe(first.context.queryId);
    expect(service.resolveAttribution(explanation.context.queryId).costTaskId).toBeNull();
    expect(service.resolveAttribution(first.context.queryId).costTaskId).toBe('task-1');
  });

  it('treats an explicit Resume as a new Query that may continue the same Task', () => {
    const original = begin({ requestKey: 'req-1' });
    if (original.status === 'conflict') throw new Error('unreachable');
    service.bindCostTask({
      queryId: original.context.queryId,
      taskId: 'task-1',
      decisionId: 'decision-1',
      basis: 'authorized_application',
      linkedAt: '2026-09-21T10:00:05.000Z',
    });
    const resume = begin({
      requestKey: 'req-resume',
      requestPayloadDigest: 'digest-resume',
      acceptedAt: '2026-09-21T11:00:00.000Z',
    });
    if (resume.status === 'conflict') throw new Error('unreachable');
    service.bindCostTask({
      queryId: resume.context.queryId,
      taskId: 'task-1',
      decisionId: 'decision-resume',
      basis: 'authorized_execution_segment',
      linkedAt: '2026-09-21T11:00:05.000Z',
    });
    expect(store.listQueryIdsForTask('task-1').sort())
      .toEqual([original.context.queryId, resume.context.queryId].sort());
    // The old segment's late usage stays attributed to the old Query.
    metering.insertObservations([{
      observationId: 'late-1',
      spanId: null,
      sourceId: 'planner',
      sourceEventKey: 'late-evt',
      sourceScope: 'model_request',
      callId: 'call-old-segment',
      queryId: original.context.queryId,
      executionSegmentId: 'segment-old',
      taskId: 'task-1',
      stage: 'execution',
      reason: 'primary',
      resource: 'model_tokens',
      metric: 'input',
      unit: 'token',
      quantityNumerator: '10',
      quantityDenominator: '1',
      quality: 'reported',
      countsTowardTotal: true,
      payer: 'platform',
      capturedAt: '2026-09-21T11:00:30.000Z',
      providerBindingVersion: null,
      evidenceRef: null,
      normalizationRuleVersion: 'usage-normalizer-v1',
    }]);
    expect(metering.listObservations(original.context.queryId)).toHaveLength(1);
    expect(metering.listObservations(resume.context.queryId)).toHaveLength(0);
  });

  it('records an automatic retry under the triggering segment Query, not a new Query', () => {
    const created = begin({ requestKey: 'req-1' });
    if (created.status === 'conflict') throw new Error('unreachable');
    const queryId = created.context.queryId;
    store.recordExecutionContext({
      executionSegmentId: 'segment-1',
      queryId,
      kind: 'task_generation',
      referenceId: 'generation-1',
      taskId: 'task-1',
      recordedAt: '2026-09-21T10:00:10.000Z',
    });
    store.recordExecutionContext({
      executionSegmentId: 'attempt-2',
      queryId,
      kind: 'attempt',
      referenceId: 'attempt-2',
      taskId: 'task-1',
      recordedAt: '2026-09-21T10:00:20.000Z',
    });
    const contexts = store.listExecutionContexts(queryId);
    expect(contexts).toHaveLength(2);
    expect(contexts.every(context => context.queryId === queryId)).toBe(true);
  });

  it('does not create a Query for control-only or replay requests', () => {
    // /status, cancel, history replay and reconnects are handled without calling
    // beginQuery at all: the store stays empty until a chargeable request exists.
    expect(store.listContextsForConversation('conversation-1')).toEqual([]);
  });

  it('reuses a replayed request key but rejects the same key with a different payload', () => {
    const first = begin({ requestKey: 'req-1', requestPayloadDigest: 'digest-1' });
    if (first.status === 'conflict') throw new Error('unreachable');
    const replay = begin({ requestKey: 'req-1', requestPayloadDigest: 'digest-1' });
    expect(replay.status).toBe('reused');
    const conflict = begin({ requestKey: 'req-1', requestPayloadDigest: 'other' });
    expect(conflict).toEqual({ status: 'conflict', reason: 'payload_mismatch' });
    const sameTextNewRequest = begin({ requestKey: 'req-2', requestPayloadDigest: 'digest-2' });
    expect(sameTextNewRequest.status).toBe('created');
    if (sameTextNewRequest.status === 'conflict') throw new Error('unreachable');
    expect(sameTextNewRequest.context.queryId).not.toBe(first.context.queryId);
  });

  it('scopes request identity by account and ingress', () => {
    const webAccountOne = begin({ requestKey: 'shared', requestPayloadDigest: 'digest-1' });
    const webAccountTwo = begin({
      requestKey: 'shared',
      requestPayloadDigest: 'digest-1',
      accountId: 'account-2',
    });
    const feishu = begin({
      requestKey: 'shared',
      requestPayloadDigest: 'digest-1',
      ingress: 'feishu',
    });
    const ids = [webAccountOne, webAccountTwo, feishu].map(result => {
      if (result.status === 'conflict') throw new Error('unreachable');
      return result.context.queryId;
    });
    expect(new Set(ids).size).toBe(3);
  });

  it('keeps attribution stable when the client switches Conversation or reconnects', () => {
    const created = begin({ requestKey: 'req-1' });
    if (created.status === 'conflict') throw new Error('unreachable');
    service.bindCostTask({
      queryId: created.context.queryId,
      taskId: 'task-1',
      decisionId: 'decision-1',
      basis: 'authorized_application',
      linkedAt: '2026-09-21T10:00:05.000Z',
    });
    // A later UI focus change is not an attribution input.
    expect(service.resolveAttribution(created.context.queryId).costTaskId).toBe('task-1');
    const second = service.bindCostTask({
      queryId: created.context.queryId,
      taskId: 'task-2',
      decisionId: 'decision-2',
      basis: 'authorized_application',
      linkedAt: '2026-09-21T10:01:00.000Z',
    });
    expect(second).toEqual({ status: 'conflict', reason: 'different_cost_task' });
  });

  it('rejects an incomplete Query context before persisting it', () => {
    expect(() => begin({ requestKey: '   ' })).toThrow('invalid_query_context:requestKey');
    expect(() => begin({ priceBookVersion: '' })).toThrow('invalid_query_context:priceBookVersion');
    expect(store.listContextsForConversation('conversation-1')).toEqual([]);
  });
});
