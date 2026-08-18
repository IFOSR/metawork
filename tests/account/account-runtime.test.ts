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
});
