import { describe, expect, it } from 'vitest';
import { AccountRuntimeFactory } from '../../src/account/account-runtime-factory.js';
import { RuntimeRegistry } from '../../src/account/runtime-registry.js';
import type { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';

function makeRegistry(failFor?: string) {
  const factory = new AccountRuntimeFactory({
    buildKernelCoordinator: (): AccountKernelCoordinator => ({
      submit: async () => ({ decisions: [], quiescent: true, pendingRecovery: 0 }),
      recover: async () => ({
        decisions: [],
        quiescent: true,
        pendingRecovery: 0,
        reconciledProcessingEvents: 0,
        applicationCounts: { pending: 0, applying: 0, applied: 0, uncertain: 0, failed: 0 },
      }),
    }),
    recoverDurableStartup: async accountId => {
      if (accountId === failFor) throw new Error(`recovery failed: ${accountId}`);
    },
  });
  return new RuntimeRegistry({ factory });
}

describe('account recovery isolation', () => {
  it('quarantines a failed account without affecting another account', async () => {
    const registry = makeRegistry('acct-bad');

    await expect(
      registry.getOrActivate({ accountId: 'acct-bad', authorized: true }),
    ).rejects.toThrow();

    // 健康账户继续服务。
    const good = await registry.getOrActivate({ accountId: 'acct-good', authorized: true });
    expect(good.accountId).toBe('acct-good');
    expect(registry.getIfLoaded('acct-good')).toBe(good);
    expect(registry.getIfLoaded('acct-bad')).toBeNull();
  });
});
