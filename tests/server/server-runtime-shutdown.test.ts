import { describe, expect, it } from 'vitest';
import { stopServerRuntimes } from '../../src/server/server-runtime-shutdown.js';

describe('Server runtime shutdown order', () => {
  it('stops the Planner, then the AccountRuntimes, then drains and stops memory', async () => {
    const calls: string[] = [];
    await stopServerRuntimes({
      stopPlanner: async () => { calls.push('planner'); },
      shutdownAccounts: async () => { calls.push('accounts'); },
      stopMemory: async () => {
        calls.push('memory');
        // The final drain itself is inside MemoryRuntime.stop(); this asserts
        // that no account can write while memory is draining.
      },
    });
    expect(calls).toEqual(['planner', 'accounts', 'memory']);
  });

  it('never stops memory before every account runtime has shut down', async () => {
    let accountsStopped = false;
    await stopServerRuntimes({
      stopPlanner: async () => undefined,
      shutdownAccounts: async () => { accountsStopped = true; },
      stopMemory: async () => {
        expect(accountsStopped).toBe(true);
      },
    });
  });
});
