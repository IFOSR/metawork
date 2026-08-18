import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AccountRuntimeFactory } from '../../src/account/account-runtime-factory.js';
import { buildAccountKernelServices } from '../../src/account/account-kernel-services.js';
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

describe('AccountKernelServices', () => {
  it('builds real kernel services from an account database', () => {
    const db = new Database(':memory:');
    const services = buildAccountKernelServices(db);

    expect(services.controlKernel).toBeDefined();
    expect(services.kernelDecisionRepo).toBeDefined();
    expect(services.kernelWorkflowRepo).toBeDefined();
  });

  it('AccountRuntime holds the injected kernel services', () => {
    const db = new Database(':memory:');
    const services = buildAccountKernelServices(db);
    const factory = new AccountRuntimeFactory({
      buildKernelCoordinator: () => mockCoordinator(),
      buildKernelServices: () => services,
      recoverDurableStartup: async () => undefined,
    });

    const runtime = factory.create('local-default');
    expect(runtime.kernelServices).toBe(services);
    expect(runtime.kernelServices.controlKernel).toBe(services.controlKernel);
    expect(runtime.kernelServices.kernelWorkflowRepo).toBe(services.kernelWorkflowRepo);
  });
});
