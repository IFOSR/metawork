import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountRouteDispatcher } from '../../src/account/account-router-dispatch.js';
import type { RouterDispatchInput } from '../../src/execution/control-execution-runtime.js';
import { RouterDispatchService } from '../../src/execution/router-dispatch-service.js';
import { RouterService, type RouterModelOutput } from '../../src/routing/router.js';
import { RouteDecisionRepo } from '../../src/storage/route-decision-repo.js';
import type { TaskStatus } from '../../src/task/task-state.js';
import type { ExecutorAttemptReceipt } from '../../src/storage/executor-attempt-receipt-repo.js';
import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  const binding = { agentClassRef: 'pi', harnessRef: 'pi-cli', providerRef: 'p', modelRef: 'm',
    permissionProfileRef: 'standard-agent', configurationRevision: 'config' };
  const subtask = { id: 'subtask', taskId: 'task', generationId: 'generation', graphRevision: 1,
    status: 'ready' as const, goal: 'write a report', acceptance: [], executorBindings: [binding] };
  const revision = { generationId: 'generation', revision: 1, configurationRevision: 'config' };
  const state: { task: TaskStatus | null; subtask: typeof subtask | null; revision: typeof revision | null } = {
    task: 'running', subtask, revision,
  };
  let finish!: (output: RouterModelOutput) => void;
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const decide = vi.fn(() => {
    notifyStarted();
    return new Promise<RouterModelOutput>(resolve => { finish = resolve; });
  });
  const modelUsage: Parameters<NonNullable<ConstructorParameters<typeof RouterDispatchService>[0]['onModelUsage']>>[0][] = [];
  const routerDispatch = new RouterDispatchService({
    router: new RouterService({ model: { providerRef: 'router', modelRef: 'router-model', decide } }),
    decisions: new RouteDecisionRepo(db),
    onModelUsage: record => modelUsage.push(record),
  });
  const transactionalReads: boolean[] = [];
  const attempts: ExecutorAttemptReceipt[] = [];
  const executorStatuses: Array<{ agentClassName: string; classHealth: 'healthy' | 'error' | 'disabled' | 'unverified';
    recentAttempts: []; recentRecoveryChecks: []; updatedAt: string }> = [];
  const dispatch = createAccountRouteDispatcher({ routerDispatch,
    readConfiguration: () => ({ revisionId: 'config', models: { m: { providerRef: 'p', modelId: 'actual-model' } } }) as any,
    readAttempts: () => attempts,
    readTaskStatus: () => { transactionalReads.push(db.inTransaction); return state.task; },
    readSubtask: () => state.subtask, readActiveRevision: () => state.revision,
    readExecutorStatuses: () => executorStatuses,
  });
  const item = { taskId: 'task', generationId: 'generation', subtaskId: 'subtask',
    attemptId: 'attempt', configurationRevision: 'config', authorizedBinding: binding,
    bindingFingerprint: 'unused', attemptKind: 'primary', attemptPayload: null } satisfies RouterDispatchInput;
  return { db, state, dispatch, item, started, decide, transactionalReads, executorStatuses, modelUsage, attempts,
    finish: () => finish({ selectedAgentClassRef: 'pi', rationale: 'fits the report' }) };
}

describe('Account production Router dispatch wiring', () => {
  it('does not exclude an Executor for a failed context read before it started', async () => {
    const fixture = setup();
    fixture.attempts.push({ attemptId: 'old', subtaskId: 'subtask', generationId: 'generation', graphRevision: 1,
      terminalState: 'executor_failed', bindingFingerprint: authorizedExecutorBindingFingerprint(fixture.item.authorizedBinding),
      failure: { stage: 'context_preparation', attemptStarted: false, externalSideEffect: false },
    } as ExecutorAttemptReceipt);
    const work = fixture.dispatch(fixture.item);
    await fixture.started;
    fixture.finish();
    expect(await work).toMatchObject({ binding: fixture.item.authorizedBinding });
  });
  it('re-reads owner facts inside the SQLite append transaction and returns the exact selected binding', async () => {
    const fixture = setup();
    const work = fixture.dispatch(fixture.item);
    await fixture.started;
    fixture.finish();
    expect(await work).toMatchObject({ binding: fixture.item.authorizedBinding, decision: { outcome: 'selected' } });
    expect(fixture.transactionalReads).toContain(true);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get()).toEqual({ n: 1 });
  });

  it.each(['cancel', 'deleted-task', 'generation', 'graph', 'configuration', 'bindings', 'deleted-subtask'])(
    'does not persist a late decision after %s changes in the owner', async change => {
      const fixture = setup();
      const work = fixture.dispatch(fixture.item);
      const assertion = expect(work).rejects.toMatchObject({ code: 'route_stale_decision' });
      await fixture.started;
      if (change === 'cancel') fixture.state.task = 'cancelled';
      if (change === 'deleted-task') fixture.state.task = null;
      if (change === 'generation') fixture.state.revision!.generationId = 'new-generation';
      if (change === 'graph') fixture.state.revision!.revision = 2;
      if (change === 'configuration') fixture.state.revision!.configurationRevision = 'new-config';
      if (change === 'bindings') fixture.state.subtask!.executorBindings = [];
      if (change === 'deleted-subtask') fixture.state.subtask = null;
      fixture.finish();
      await assertion;
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get()).toEqual({ n: 0 });
    },
  );

  it('re-reads Executor availability at commit time and never routes to an unavailable AgentClass', async () => {
    const fixture = setup();
    fixture.executorStatuses.push({
      agentClassName: 'pi',
      classHealth: 'disabled',
      recentAttempts: [],
      recentRecoveryChecks: [],
      updatedAt: new Date().toISOString(),
    });
    const result = await fixture.dispatch(fixture.item);
    expect(result).toMatchObject({ binding: null, decision: { outcome: 'no_candidate' } });
    expect(fixture.decide).not.toHaveBeenCalled();
    expect(result.decision?.excluded).toContainEqual({ agentClassRef: 'pi', reason: 'provider_unavailable' });
  });

  it('carries the deciding Query into Router metering and writes nothing without one', async () => {
    const withQuery = setup();
    const first = withQuery.dispatch({ ...withQuery.item, queryId: 'query-1' });
    await withQuery.started;
    withQuery.finish();
    await first;
    expect(withQuery.modelUsage).toHaveLength(1);
    expect(withQuery.modelUsage[0]).toMatchObject({
      queryId: 'query-1', providerRef: 'router', modelId: 'router-model', outcome: 'selected',
    });

    const withoutQuery = setup();
    const second = withoutQuery.dispatch(withoutQuery.item);
    await withoutQuery.started;
    withoutQuery.finish();
    await second;
    // No account-bound Query: the call is real but unattributable, so no fact
    // is written instead of inventing an account or a zero.
    expect(withoutQuery.modelUsage).toEqual([]);
  });

  it('records no-candidate when no bindings remain instead of falling back to the suggested binding', async () => {
    const fixture = setup();
    fixture.state.subtask!.executorBindings = [];
    expect(await fixture.dispatch(fixture.item)).toMatchObject({ binding: null, decision: { outcome: 'no_candidate' } });
    expect(fixture.decide).not.toHaveBeenCalled();
  });
});
