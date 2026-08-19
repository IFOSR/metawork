import { describe, expect, it } from 'vitest';
import { AccountRuntime } from '../../src/account/account-runtime.js';
import { AccountRuntimeFactory } from '../../src/account/account-runtime-factory.js';
import type { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';

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
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
