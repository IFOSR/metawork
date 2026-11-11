import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AccountRuntimeFactory } from '../../src/account/account-runtime-factory.js';
import { buildAccountControlServices } from '../../src/account/account-control-services.js';
import type { AccountControlCoordinator } from '../../src/account/account-control-coordinator.js';

function mockCoordinator(): AccountControlCoordinator {
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

describe('AccountControlServices', () => {
  it('builds real kernel services from an account database', () => {
    const db = new Database(':memory:');
    const services = buildAccountControlServices(db);

    expect(services.controlLoop).toBeDefined();
    // D6: the decision/event ledger is gone; only owner recovery facts remain.
    expect(services.recoveryItems).toBeDefined();
  });

  it('AccountRuntime holds the injected kernel services', () => {
    const db = new Database(':memory:');
    const services = buildAccountControlServices(db);
    const factory = new AccountRuntimeFactory({
      buildControlCoordinator: () => mockCoordinator(),
      buildControlServices: () => services,
      recoverDurableStartup: async () => undefined,
    });

    const runtime = factory.create('local-default');
    expect(runtime.kernelServices).toBe(services);
    expect(runtime.kernelServices.controlLoop).toBe(services.controlLoop);
    expect(runtime.kernelServices.kernelWorkflowRepo).toBe(services.kernelWorkflowRepo);
  });
});
