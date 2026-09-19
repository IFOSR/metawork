import { describe, expect, it } from 'vitest';
import { AccountRuntime, WorkAdmissionBlockedError } from '../../src/account/account-runtime.js';
import { AccountRuntimeFactory } from '../../src/account/account-runtime-factory.js';
import type { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';
import {
  ConfigurationActivationBlockedError,
} from '../../src/configuration/configuration-activation-gate.js';
import type { Task, TaskStatus } from '../../src/core/types.js';

function makeMockCoordinator(): AccountKernelCoordinator {
  return {
    submit: async () => ({ decisions: [], quiescent: true, pendingRecovery: 0 }),
    recover: async () => ({
      decisions: [],
      quiescent: true,
      pendingRecovery: 0,
      reconciledProcessingEvents: 0,
      applicationCounts: { pending: 0, applying: 0, applied: 0, uncertain: 0, failed: 0 },
    }),
  };
}

function makeTask(taskId: string, status: TaskStatus, conversationId = 'conv-1'): Task {
  return {
    id: taskId,
    title: taskId,
    status,
    conversationId,
    dependencies: [],
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
  } as unknown as Task;
}

function makeIdleRuntimeDeps(tasks: Task[] = []) {
  return {
    accountId: 'local-default',
    kernelCoordinator: makeMockCoordinator(),
    kernelServices: {
      kernelDecisionRepo: { listByTask: () => [] },
    } as never,
    repositories: {
      conversationTaskSchedulerRepo: { listSlots: () => [] },
      workGraphRevisionRepo: { findActive: () => null },
    } as never,
    workspaceServices: {
      attemptExecutionRepository: { listActive: () => [] },
    } as never,
    runtimeExecutionServices: {
      dispatchItemRepo: { listBlocking: () => [] },
      resourceLeaseService: { findActive: () => [] },
      publicationRepo: { hasAnyBlockingResidue: () => false },
    } as never,
    taskServices: {
      taskRuntimeService: {
        listTasks: () => tasks,
        listTasksByStatus: (status: TaskStatus) => tasks.filter(task => task.status === status),
        findTask: (taskId: string) => tasks.find(task => task.id === taskId) ?? null,
      },
    } as never,
    recoverDurableStartup: async () => undefined,
  };
}

describe('AccountRuntime', () => {
  it('runs startup recovery exactly once per account', async () => {
    let recoveryCount = 0;
    const factory = new AccountRuntimeFactory({
      buildKernelCoordinator: () => makeMockCoordinator(),
      recoverDurableStartup: async () => { recoveryCount += 1; },
    });
    const runtime = factory.create('local-default');

    await runtime.initialize();
    await runtime.initialize();
    await runtime.initialize();

    expect(recoveryCount).toBe(1);
  });

  it('allows startup recovery to retry after a transient failure', async () => {
    let attempts = 0;
    const runtime = new AccountRuntime({
      accountId: 'local-default',
      kernelCoordinator: makeMockCoordinator(),
      kernelServices: {} as never,
      repositories: {} as never,
      workspaceServices: {} as never,
      recoverDurableStartup: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary recovery failure');
      },
    });

    await expect(runtime.initialize()).rejects.toThrow('temporary recovery failure');
    await expect(runtime.initialize()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('shares one kernel coordinator across all conversation ports', () => {
    const factory = new AccountRuntimeFactory({
      buildKernelCoordinator: () => makeMockCoordinator(),
      recoverDurableStartup: async () => undefined,
    });
    const runtime = factory.create('local-default');

    const portA = runtime.getConversationPort();
    const portB = runtime.getConversationPort();

    expect(portA.accountId).toBe('local-default');
    expect(portB.accountId).toBe('local-default');
    expect(runtime.kernelCoordinator).toBe(runtime.kernelCoordinator);
  });

  it('factory builds the coordinator once per account activation', () => {
    let builds = 0;
    const factory = new AccountRuntimeFactory({
      buildKernelCoordinator: () => {
        builds += 1;
        return makeMockCoordinator();
      },
      recoverDurableStartup: async () => undefined,
    });

    const runtime = factory.create('local-default');
    expect(builds).toBe(1);
    // 同一个 runtime 的协调器引用稳定。
    expect(runtime.kernelCoordinator).toBe(runtime.kernelCoordinator);

    // 第二个账户激活各建各的协调器。
    factory.create('acct_two');
    expect(builds).toBe(2);
  });

  it('does not close while account work is active', async () => {
    let disposed = 0;
    const runtime = new AccountRuntime({
      accountId: 'local-default',
      kernelCoordinator: makeMockCoordinator(),
      kernelServices: {} as never,
      repositories: {} as never,
      workspaceServices: {} as never,
      recoverDurableStartup: async () => undefined,
      dispose: async () => { disposed += 1; },
    });

    runtime.beginWork();
    await expect(runtime.closeWhenIdle()).resolves.toBe('busy');
    expect(disposed).toBe(0);

    runtime.endWork();
    await expect(runtime.closeWhenIdle()).resolves.toBe('closed');
    expect(disposed).toBe(1);
  });

  it('publishes Conversation-owned planning activity through the factory callback', async () => {
    const published: Array<{ accountId: string; conversationId: string; state: string }> = [];
    const factory = new AccountRuntimeFactory({
      buildKernelCoordinator: () => makeMockCoordinator(),
      recoverDurableStartup: async () => undefined,
      onConversationActivityChanged: (accountId, conversationId, activity) => {
        published.push({ accountId, conversationId, state: activity.state });
      },
    });
    const runtime = factory.create('local-default');

    runtime.setConversationPlannerActive('conv_origin', true);
    await Promise.resolve();
    runtime.setConversationPlannerActive('conv_origin', false);
    await Promise.resolve();

    expect(published).toEqual([
      { accountId: 'local-default', conversationId: 'conv_origin', state: 'planning' },
      { accountId: 'local-default', conversationId: 'conv_origin', state: 'idle' },
    ]);
  });

  it('does not treat generic account work as an active Planner turn', () => {
    const factory = new AccountRuntimeFactory({
      buildKernelCoordinator: () => makeMockCoordinator(),
      recoverDurableStartup: async () => undefined,
    });
    const runtime = factory.create('local-default');

    runtime.beginWork();

    expect(runtime.getConversationActivity('conv_origin', '2026-08-27T08:00:00.000Z'))
      .toMatchObject({ state: 'idle', taskId: null });
  });

  it('single-flights account periodic recovery and waits for it before disposal', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reviews = 0;
    let disposed = 0;
    const runtime = new AccountRuntime({
      accountId: 'local-default',
      kernelCoordinator: makeMockCoordinator(),
      kernelServices: {} as never,
      repositories: {} as never,
      workspaceServices: {} as never,
      recoverDurableStartup: async () => undefined,
      reviewTaskPoolOnTimer: async () => {
        reviews += 1;
        await gate;
        return true;
      },
      dispose: async () => { disposed += 1; },
    });

    const first = runtime.reviewTaskPoolOnTimer();
    const second = runtime.reviewTaskPoolOnTimer();
    expect(first).toBe(second);
    let closed = false;
    const closing = runtime.closeWhenIdle().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(reviews).toBe(1);

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await closing;
    expect(disposed).toBe(1);
  });

  it('rejects client attachment after disposal starts', async () => {
    const disposal = deferred<void>();
    const runtime = new AccountRuntime({
      accountId: 'local-default',
      kernelCoordinator: makeMockCoordinator(),
      kernelServices: {} as never,
      repositories: {} as never,
      workspaceServices: {} as never,
      recoverDurableStartup: async () => undefined,
      dispose: async () => disposal.promise,
    });

    const closing = runtime.closeWhenIdle();
    expect(() => runtime.attachClient()).toThrow('AccountRuntime is closing');

    disposal.resolve();
    await expect(closing).resolves.toBe('closed');
    expect(() => runtime.attachClient()).toThrow('AccountRuntime is closed');
  });

  it('rejects new work while a configuration transaction is active', async () => {
    const runtime = new AccountRuntime(makeIdleRuntimeDeps());
    await runtime.initialize();

    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const activation = runtime.withConfigurationActivation(async () => hold);
    await Promise.resolve();

    expect(() => runtime.beginWork()).toThrow(WorkAdmissionBlockedError);
    try {
      runtime.beginWork();
    } catch (error) {
      expect((error as WorkAdmissionBlockedError).code).toBe('configuration_updating');
    }
    expect(() => runtime.reserveWork()).toThrow(WorkAdmissionBlockedError);

    release();
    await activation;
    expect(() => runtime.beginWork()).not.toThrow();
    runtime.endWork();
  });

  it('blocks configuration activation while admitted work is still active', async () => {
    const runtime = new AccountRuntime(makeIdleRuntimeDeps());
    await runtime.initialize();

    runtime.reserveWork();
    const status = runtime.getConfigurationActivationStatus();
    expect(status.activationAllowed).toBe(false);
    expect(status.blockingReasons.map(reason => reason.code))
      .toContain('work_request_pending');
    await expect(runtime.withConfigurationActivation(async () => undefined))
      .rejects.toThrow(ConfigurationActivationBlockedError);

    runtime.releaseWork();
    await expect(runtime.withConfigurationActivation(async () => 'ok')).resolves.toBe('ok');
  });

  it('reports continuable unfinished tasks as activation-blocking facts', async () => {
    const tasks = [
      makeTask('task-created', 'created'),
      makeTask('task-ready', 'ready'),
      makeTask('task-parked', 'parked', 'conv-2'),
      makeTask('task-blocked', 'blocked'),
      makeTask('task-done', 'done'),
      makeTask('task-cancelled', 'cancelled'),
    ];
    const runtime = new AccountRuntime(makeIdleRuntimeDeps(tasks));
    await runtime.initialize();

    const facts = runtime.getConfigurationActivationFacts();
    expect(facts.unfinishedWork.count).toBe(4);
    expect(facts.unfinishedWork.items.map(item => item.taskId).sort()).toEqual([
      'task-blocked',
      'task-created',
      'task-parked',
      'task-ready',
    ]);
    const status = runtime.getConfigurationActivationStatus();
    expect(status.activationAllowed).toBe(false);
    expect(status.blockingReasons.map(reason => reason.code)).toContain('unfinished_task');

    const idleRuntime = new AccountRuntime(makeIdleRuntimeDeps([
      makeTask('task-done', 'done'),
      makeTask('task-archived', 'archived'),
      makeTask('task-cancelled', 'cancelled'),
    ]));
    await idleRuntime.initialize();
    expect(idleRuntime.getConfigurationActivationStatus().activationAllowed).toBe(true);
  });

  it('skips periodic recovery side effects while a configuration transaction is active', async () => {
    let reviews = 0;
    const runtime = new AccountRuntime({
      ...makeIdleRuntimeDeps(),
      reviewTaskPoolOnTimer: async () => {
        reviews += 1;
        return true;
      },
    });
    await runtime.initialize();

    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const activation = runtime.withConfigurationActivation(async () => hold);
    await Promise.resolve();

    await expect(runtime.reviewTaskPoolOnTimer()).resolves.toBe(false);
    expect(reviews).toBe(0);

    release();
    await activation;
    await expect(runtime.reviewTaskPoolOnTimer()).resolves.toBe(true);
    expect(reviews).toBe(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
