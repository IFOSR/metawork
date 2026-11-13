import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouterDispatchService } from '../../src/execution/router-dispatch-service.js';
import { RouterService, type RouteRequest, type RouterModelOutput } from '../../src/routing/router.js';
import { RouteDecisionRepo } from '../../src/storage/route-decision-repo.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const request: RouteRequest = {
  taskId: 'task', generationId: 'generation', subtaskId: 'subtask', graphRevision: 1,
  attemptOrdinal: 1, goal: 'write a report', acceptance: ['report exists'], configurationRevision: 'config',
  candidates: [{ agentClassRef: 'pi', providerRef: 'provider', modelRef: 'model', permissionProfileRef: 'standard-agent' }],
  excluded: [], modelCatalog: [{ providerRef: 'provider', modelRef: 'model', modelId: 'model-id' }],
};
const output: RouterModelOutput = { selectedAgentClassRef: 'pi', rationale: 'suitable for the requested report' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  const decisions = new RouteDecisionRepo(db);
  const started = deferred<AbortSignal>();
  const result = deferred<RouterModelOutput>();
  const decide = vi.fn(async (_input: RouteRequest, signal: AbortSignal) => {
    started.resolve(signal);
    return result.promise;
  });
  const router = new RouterService({ model: { providerRef: 'provider', modelRef: 'decision-model', decide } });
  const service = new RouterDispatchService({ router, decisions });
  let current: RouteRequest | null = request;
  return { db, decisions, router, service, started, result, decide,
    target: { request, readCurrentRequest: () => current },
    setCurrent: (value: RouteRequest | null) => { current = value; } };
}

describe('Router dispatch persistence', () => {
  it('coalesces concurrent calls and returns independent copies of one durable decision', async () => {
    const fixture = setup();
    const first = fixture.service.route(fixture.target);
    const second = fixture.service.route(fixture.target);
    await fixture.started.promise;
    fixture.result.resolve(output);
    const [one, two] = await Promise.all([first, second]);
    expect(fixture.decide).toHaveBeenCalledTimes(1);
    expect(one).toEqual(two);
    expect(one).not.toBe(two);
    expect(fixture.decisions.findById(one.routeDecisionId)).toEqual(one);
  });

  it.each(['cancelled-task', 'graph-change', 'config-change'] as const)('refuses a late model decision after %s', async change => {
    const fixture = setup();
    const work = fixture.service.route(fixture.target);
    const assertion = expect(work).rejects.toMatchObject({ code: 'route_stale_decision' });
    await fixture.started.promise;
    fixture.setCurrent(change === 'cancelled-task' ? null : {
      ...request, ...(change === 'graph-change' ? { graphRevision: 2 } : { configurationRevision: 'new-config' }),
    });
    fixture.result.resolve(output);
    await assertion;
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM route_decisions').get()).toEqual({ count: 0 });
  });

  it('checks the live owner state within the append transaction', async () => {
    const fixture = setup();
    const checks: boolean[] = [];
    const work = fixture.service.route({ request, readCurrentRequest: () => {
      checks.push(fixture.db.inTransaction);
      return request;
    } });
    await fixture.started.promise;
    fixture.result.resolve(output);
    await work;
    expect(checks).toContain(true);
  });

  it('one cancelled waiter does not cancel another caller of the same route', async () => {
    const fixture = setup();
    const abort = new AbortController();
    const first = fixture.service.route({ ...fixture.target, signal: abort.signal });
    const second = fixture.service.route(fixture.target);
    const assertion = expect(first).rejects.toMatchObject({ code: 'route_cancelled' });
    const modelSignal = await fixture.started.promise;
    abort.abort();
    await assertion;
    expect(modelSignal.aborted).toBe(false);
    fixture.result.resolve(output);
    await expect(second).resolves.toMatchObject({ outcome: 'selected' });
    expect(fixture.decide).toHaveBeenCalledTimes(1);
  });

  it('cancels the physical model when its last caller leaves and never saves a late result', async () => {
    const fixture = setup();
    const abort = new AbortController();
    const work = fixture.service.route({ ...fixture.target, signal: abort.signal });
    const assertion = expect(work).rejects.toMatchObject({ code: 'route_cancelled' });
    const modelSignal = await fixture.started.promise;
    abort.abort();
    await assertion;
    expect(modelSignal.aborted).toBe(true);
    fixture.result.resolve(output);
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM route_decisions').get()).toEqual({ count: 0 });
    // Cancellation releases the in-flight identity, allowing an explicit retry.
    await expect(fixture.service.route(fixture.target)).resolves.toMatchObject({ outcome: 'selected' });
  });

  it('returns the durable winner when independent service instances disagree', async () => {
    const fixture = setup();
    const other = new RouterDispatchService({ router: new RouterService({ model: {
      providerRef: 'provider', modelRef: 'decision-model', decide: async () => ({ ...output, rationale: 'another valid choice' }),
    } }), decisions: fixture.decisions });
    const pending = fixture.service.route(fixture.target);
    await fixture.started.promise;
    const winner = await other.route(fixture.target);
    fixture.result.resolve(output);
    expect(await pending).toEqual(winner);
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM route_decisions').get()).toEqual({ count: 1 });
  });

  it('preserves the original snapshot if a caller mutates its request during a model call', async () => {
    const fixture = setup();
    const mutable = structuredClone(request);
    const work = fixture.service.route({ request: mutable, readCurrentRequest: () => request });
    await fixture.started.promise;
    mutable.goal = 'a different goal';
    fixture.result.resolve(output);
    const decision = await work;
    fixture.router.assertFresh(decision, request);
    expect(() => fixture.router.assertFresh(decision, mutable)).toThrow('stale');
  });

  it('replays no-candidate without re-running the model and refuses a cancelled replay', async () => {
    const fixture = setup();
    const work = fixture.service.route(fixture.target);
    await fixture.started.promise;
    fixture.result.resolve({ selectedAgentClassRef: null, rationale: 'none fits' });
    const decision = await work;
    expect(await fixture.service.route(fixture.target)).toEqual(decision);
    expect(fixture.decide).toHaveBeenCalledTimes(1);
    await expect(fixture.service.route({ ...fixture.target, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: 'route_cancelled' });
  });

  it('rejects forged audit snapshots and accepts equivalent object property order', async () => {
    const fixture = setup();
    const work = fixture.service.route(fixture.target);
    await fixture.started.promise;
    fixture.result.resolve(output);
    const decision = await work;
    expect(() => fixture.decisions.record(request, { ...decision, candidates: [] })).toThrow('input_mismatch');
    expect(() => fixture.decisions.record(request, { ...decision, excluded: [{ agentClassRef: 'other', reason: 'disabled' }] }))
      .toThrow('input_mismatch');
    expect(fixture.decisions.record(request, { ...decision, selected: {
      modelRef: 'model', permissionProfileRef: 'standard-agent', providerRef: 'provider', agentClassRef: 'pi',
    } })).toBe('replayed');
  });
});

describe('Router decision-model metering', () => {
  function usageSetup(modelOutput: RouterModelOutput) {
    const db = new Database(':memory:');
    databases.push(db);
    const records: Parameters<NonNullable<ConstructorParameters<typeof RouterDispatchService>[0]['onModelUsage']>>[0][] = [];
    const router = new RouterService({
      model: {
        providerRef: 'metawork-router',
        modelRef: 'span-routing-v1',
        decide: async () => modelOutput,
      },
      now: () => '2026-11-10T00:00:00.000Z',
    });
    const service = new RouterDispatchService({
      router,
      decisions: new RouteDecisionRepo(db),
      onModelUsage: record => records.push(record),
    });
    return {
      db,
      service,
      records,
      target: { request, readCurrentRequest: () => request, queryId: 'query-1' },
    };
  }

  it('records one usage fact per actual call and none for a replay', async () => {
    const fixture = usageSetup({
      ...output,
      usage: { inputTokens: 12, outputTokens: 3 },
      callAttempted: true,
      occurredAtUtc: '2026-11-10T00:00:01.000Z',
    });
    const decision = await fixture.service.route(fixture.target);
    expect(fixture.records).toHaveLength(1);
    expect(fixture.records[0]).toMatchObject({
      queryId: 'query-1',
      routeDecisionId: decision.routeDecisionId,
      providerRef: 'metawork-router',
      modelId: 'span-routing-v1',
      outcome: 'selected',
      usage: { inputTokens: 12, outputTokens: 3 },
      occurredAtUtc: '2026-11-10T00:00:01.000Z',
    });
    await fixture.service.route(fixture.target);
    expect(fixture.records).toHaveLength(1);
  });

  it('records a missing-usage fact for a called model that reported none', async () => {
    const fixture = usageSetup({ ...output, callAttempted: true });
    await fixture.service.route(fixture.target);
    expect(fixture.records).toHaveLength(1);
    expect(fixture.records[0]?.usage).toBeUndefined();
    expect(fixture.records[0]?.occurredAtUtc).toBe('2026-11-10T00:00:00.000Z');
  });

  it('records nothing when the model was never called or the dispatch has no Query', async () => {
    const notCalled = usageSetup({ ...output, callAttempted: false });
    await notCalled.service.route(notCalled.target);
    expect(notCalled.records).toEqual([]);

    const noQuery = usageSetup({ ...output, usage: { inputTokens: 1, outputTokens: 1 }, callAttempted: true });
    await noQuery.service.route({ ...noQuery.target, queryId: null });
    expect(noQuery.records).toEqual([]);
  });
});

