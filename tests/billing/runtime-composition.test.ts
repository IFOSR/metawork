import { afterEach, describe, expect, it } from 'vitest';
import { createBillingHarness } from './harness.js';
import {
  billingModelPriceInputs,
  createServerBillingServices,
  resolveConfiguredUsagePayer,
} from '../../src/server/billing-composition.js';
import { findPriceUnit } from '../../src/billing/pricing.js';

const harnesses: ReturnType<typeof createBillingHarness>[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.close(); });

function setup() {
  const h = createBillingHarness();
  harnesses.push(h);
  return { h, services: createServerBillingServices(h.db) };
}

const input = {
  accountId: 'account-1',
  ingress: 'web' as const,
  requestKey: 'request-1',
  requestPayloadDigest: 'digest-1',
  requestId: 'request-1',
  conversationId: 'conv-1',
  turnId: 'turn-1',
  priceBookVersion: 'unconfigured',
  feePolicyVersion: 'unconfigured',
  payerPolicyVersion: 'unknown-v1',
  acceptedAt: '2026-09-21T00:00:00.000Z',
};

describe('server billing composition', () => {
  it('uses platform as the default payer when no deployment override is configured', () => {
    expect(resolveConfiguredUsagePayer({})).toBe('platform');
    expect(resolveConfiguredUsagePayer({
      METAWORK_BILLING_DEFAULT_PAYER: 'user_direct',
    })).toBe('user_direct');
    expect(resolveConfiguredUsagePayer({
      METAWORK_BILLING_DEFAULT_PAYER: 'unknown',
    })).toBe('unknown');
    expect(resolveConfiguredUsagePayer({
      METAWORK_BILLING_DEFAULT_PAYER: 'not-a-payer',
    })).toBe('platform');
  });

  it('preserves configured model prices when configuration snapshots are converted', () => {
    expect(billingModelPriceInputs([
      {
        providerRef: 'provider-a',
        modelId: 'model-a',
        costInputPerMillion: 1.25,
        costOutputPerMillion: 9.5,
      },
    ])).toEqual([{
      providerRef: 'provider-a',
      modelId: 'model-a',
      costInputPerMillion: 1.25,
      costOutputPerMillion: 9.5,
    }]);
  });

  it('refreshes the price book for new Queries without changing pinned history', () => {
    const h = createBillingHarness();
    harnesses.push(h);
    const services = createServerBillingServices(h.db);
    const oldQuery = services.lifecycle.beginQuery({
      ...input,
      requestKey: 'request-before-refresh',
      priceBookVersion: services.priceBookVersion,
      feePolicyVersion: services.feePolicyVersion,
    });
    if (oldQuery.status === 'conflict') throw new Error('unexpected conflict');

    services.refreshConfiguration({
      configurationRevision: 'revision-hot-price',
      models: [{
        providerRef: 'deepseek',
        modelId: 'deepseek-flash',
        costInputPerMillion: 1,
        costOutputPerMillion: 2,
      }],
    });

    expect(services.priceBookVersion).toBe('config:revision-hot-price');
    expect(services.contexts.findById(oldQuery.context.queryId)?.priceBookVersion)
      .toBe('unconfigured');
    const newQuery = services.lifecycle.beginQuery({
      ...input,
      requestKey: 'request-after-refresh',
      priceBookVersion: services.priceBookVersion,
      feePolicyVersion: services.feePolicyVersion,
    });
    if (newQuery.status === 'conflict') throw new Error('unexpected conflict');
    expect(newQuery.context.priceBookVersion).toBe('config:revision-hot-price');
  });

  it('pins the explicitly loaded price book and retains Provider/model scoping', () => {
    const h = createBillingHarness();
    harnesses.push(h);
    const services = createServerBillingServices(h.db, {
      configurationRevision: 'revision-fallback',
      models: [{
        providerRef: 'fallback', modelId: 'model', costInputPerMillion: 10,
      }],
    }, {
      METAWORK_BILLING_PRICE_BOOK_JSON: JSON.stringify({
        priceBookVersion: 'explicit-prices', feePolicyVersion: 'explicit-policy',
        markupBps: '4000', effectiveFrom: '2026-09-22T00:00:00.000Z',
        units: [{
          resource: 'model_tokens', metric: 'input',
          providerRef: 'provider-a', modelId: 'model-a',
          numerator: '1000', denominator: '1',
        }],
      }),
    });
    expect(services.priceBookVersion).toBe('explicit-prices');
    expect(services.feePolicyVersion).toBe('explicit-policy');
    const book = h.prices.find('explicit-prices')!;
    expect(findPriceUnit(book, {
      resource: 'model_tokens', metric: 'input',
      providerRef: 'provider-a', modelId: 'model-a',
    })).not.toBeNull();
    expect(findPriceUnit(book, {
      resource: 'model_tokens', metric: 'input',
      providerRef: 'provider-b', modelId: 'model-a',
    })).toBeNull();
  });

  it('loads model profile prices into a versioned price book for new Queries', () => {
    const h = createBillingHarness();
    harnesses.push(h);
    const services = createServerBillingServices(h.db, {
      configurationRevision: 'revision-model-prices',
      models: [{
        providerRef: 'deepseek',
        modelId: 'deepseek-flash',
        costInputPerMillion: 1,
        costOutputPerMillion: 2,
      }],
    });
    expect(services.priceBookVersion).toBe('config:revision-model-prices');
    const started = services.lifecycle.beginQuery({
      ...input,
      priceBookVersion: services.priceBookVersion,
      feePolicyVersion: services.feePolicyVersion,
    });
    if (started.status === 'conflict') throw new Error('unexpected conflict');
    h.metering.insertObservations([{
      observationId: 'obs-configured-price',
      spanId: null,
      sourceId: 'planner',
      sourceEventKey: 'event-configured-price',
      sourceScope: 'model_request',
      callId: 'call-configured-price',
      queryId: started.context.queryId,
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
      agentClassRef: 'planner',
      providerRef: 'deepseek',
      modelId: 'deepseek-flash',
      capturedAt: input.acceptedAt,
      providerBindingVersion: null,
      evidenceRef: null,
      normalizationRuleVersion: 'usage-normalizer-v1',
    }]);
    services.lifecycle.finalizeQuery({
      queryId: started.context.queryId,
      finalizedAt: '2026-09-21T00:01:00.000Z',
    });
    const bill = services.queries.getQueryBill(started.context.queryId);
    expect(bill?.state).toBe('finalized');
    expect(bill?.assessedMicroCoin).toBe('1400');
  });

  it('retains missing usage and prices as pending, without exporting', () => {
    const { h, services } = setup();
    const started = services.lifecycle.beginQuery(input);
    if (started.status === 'conflict') throw new Error('unexpected conflict');
    services.lifecycle.finalizeQuery({
      queryId: started.context.queryId,
      finalizedAt: '2026-09-21T00:01:00.000Z',
    });
    const bill = services.queries.getQueryBillForAccount('account-1', started.context.queryId);
    expect(bill?.state).toBe('pending_reconciliation');
    expect(bill?.coverage).toBe('incomplete');
    expect(bill?.coverageNote).toContain('price_book_unavailable');
    expect(h.outbox.listByStates(['pending', 'not_exported'], 100)).toEqual([]);
    expect(h.metering.listObservations(started.context.queryId)).toEqual([]);
  });

  it('does not close a Task execution segment when the Planner finishes', () => {
    const { h, services } = setup();
    const started = services.lifecycle.beginQuery(input);
    if (started.status === 'conflict') throw new Error('unexpected conflict');
    services.lifecycle.bindCostTask({
      queryId: started.context.queryId,
      taskId: 'task-1',
      decisionId: 'decision-1',
      basis: 'authorized_application',
      linkedAt: input.acceptedAt,
    });
    h.metering.openSpan({
      spanId: 'span_execution_1',
      queryId: started.context.queryId,
      executionSegmentId: 'segment_1',
      sourceId: 'executor',
      sourceScope: 'attempt',
      callId: 'attempt_1',
      stage: 'execution',
      reason: 'primary',
      state: 'started',
      payer: 'unknown',
      startedAt: input.acceptedAt,
      closedAt: null,
    });
    services.lifecycle.finalizeQuery({
      queryId: started.context.queryId,
      finalizedAt: '2026-09-21T00:01:00.000Z',
    });
    expect(h.metering.listOpenSpans(started.context.queryId)).toHaveLength(1);
    expect(services.queries.getQueryBill(started.context.queryId)?.state)
      .toBe('pending_reconciliation');
  });

  it('finalizes all Queries linked to a Task when the Task reaches terminal recovery', () => {
    const { h, services } = setup();
    const started = services.lifecycle.beginQuery(input);
    if (started.status === 'conflict') throw new Error('unexpected conflict');
    services.lifecycle.bindCostTask({
      queryId: started.context.queryId,
      taskId: 'task-terminal',
      decisionId: 'decision-terminal',
      basis: 'authorized_application',
      linkedAt: input.acceptedAt,
    });
    h.metering.openSpan({
      spanId: 'span_execution_terminal',
      queryId: started.context.queryId,
      executionSegmentId: 'segment_terminal',
      sourceId: 'executor',
      sourceScope: 'attempt',
      callId: 'attempt_terminal',
      stage: 'execution',
      reason: 'primary',
      state: 'closed',
      payer: 'unknown',
      startedAt: input.acceptedAt,
      closedAt: '2026-09-21T00:00:30.000Z',
    });

    services.lifecycle.finalizeQueriesForTask(
      'task-terminal',
      '2026-09-21T00:01:00.000Z',
    );

    expect(h.metering.listOpenSpans(started.context.queryId)).toHaveLength(0);
    expect(services.queries.getQueryBill(started.context.queryId)?.state)
      .toBe('pending_reconciliation');
  });

  it('reuses the Query and never reopens its ended request span', () => {
    const { h, services } = setup();
    const first = services.lifecycle.beginQuery(input);
    if (first.status === 'conflict') throw new Error('unexpected conflict');
    services.lifecycle.finalizeQuery({
      queryId: first.context.queryId,
      finalizedAt: '2026-09-21T00:01:00.000Z',
    });
    const second = services.lifecycle.beginQuery(input);
    expect(second).toMatchObject({ status: 'reused', context: first.context });
    expect(h.metering.listSpans(first.context.queryId)).toHaveLength(1);
    expect(h.metering.listOpenSpans(first.context.queryId)).toHaveLength(0);
  });
});
