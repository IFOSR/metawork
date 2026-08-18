import { describe, expect, it } from 'vitest';
import { AccountRuntimeFactory } from '../../src/account/account-runtime-factory.js';
import { RuntimeRegistry } from '../../src/account/runtime-registry.js';
import type { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';

function mockCoordinator(): AccountKernelCoordinator {
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

function makeRegistry(options: {
  onBuild?: (accountId: string) => void;
  failRecoverFor?: Set<string>;
  onDispose?: (accountId: string) => void;
} = {}): RuntimeRegistry {
  const factory = new AccountRuntimeFactory({
    buildKernelCoordinator: (accountId) => {
      options.onBuild?.(accountId);
      return mockCoordinator();
    },
    recoverDurableStartup: async (accountId) => {
      if (options.failRecoverFor?.has(accountId)) {
        throw new Error(`recovery failed: ${accountId}`);
      }
    },
    dispose: options.onDispose
      ? async (accountId) => options.onDispose!(accountId)
      : async () => undefined,
  });
  return new RuntimeRegistry({ factory });
}

describe('RuntimeRegistry', () => {
  it('activates the same account once under concurrent requests', async () => {
    let builds = 0;
    const registry = makeRegistry({ onBuild: () => { builds += 1; } });

    const [a, b, c] = await Promise.all([
      registry.getOrActivate({ accountId: 'local-default', authorized: true }),
      registry.getOrActivate({ accountId: 'local-default', authorized: true }),
      registry.getOrActivate({ accountId: 'local-default', authorized: true }),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(builds).toBe(1);
  });

  it('rejects unauthorized accounts without activation', async () => {
    let builds = 0;
    const registry = makeRegistry({ onBuild: () => { builds += 1; } });

    await expect(
      registry.getOrActivate({ accountId: 'local-default', authorized: false }),
    ).rejects.toThrow();

    expect(builds).toBe(0);
    expect(registry.getIfLoaded('local-default')).toBeNull();
  });

  it('isolates a failed account from another loaded account', async () => {
    const registry = makeRegistry({ failRecoverFor: new Set(['acct-bad']) });

    await expect(
      registry.getOrActivate({ accountId: 'acct-bad', authorized: true }),
    ).rejects.toThrow();

    const good = await registry.getOrActivate({ accountId: 'acct-good', authorized: true });
    expect(good.accountId).toBe('acct-good');
    expect(registry.getIfLoaded('acct-good')).toBe(good);
    expect(registry.getIfLoaded('acct-bad')).toBeNull();
  });

  it('returns the loaded runtime from getIfLoaded', async () => {
    const registry = makeRegistry();
    expect(registry.getIfLoaded('local-default')).toBeNull();

    const runtime = await registry.getOrActivate({ accountId: 'local-default', authorized: true });
    expect(registry.getIfLoaded('local-default')).toBe(runtime);
  });

  it('disposes each loaded runtime exactly once on shutdown', async () => {
    const disposed: string[] = [];
    const registry = makeRegistry({ onDispose: accountId => disposed.push(accountId) });

    await registry.getOrActivate({ accountId: 'local-default', authorized: true });
    await registry.getOrActivate({ accountId: 'acct-two', authorized: true });
    await registry.shutdown();
    await registry.shutdown();

    expect(disposed.sort()).toEqual(['acct-two', 'local-default']);
  });
});
