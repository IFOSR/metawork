import { describe, expect, it } from 'vitest';
import { stopServerRuntimes } from '../../src/server/server-runtime-shutdown.js';

describe('Server runtime shutdown order', () => {
  it('deposits memory before releasing AccountRuntime storage', async () => {
    const calls: string[] = [];
    await stopServerRuntimes({
      stopPlanner: async () => { calls.push('planner'); },
      stopMemory: async () => { calls.push('memory'); },
      shutdownAccounts: async () => { calls.push('accounts'); },
    });
    // Releasing storage first made the final deposition fail with
    // "The database connection is not open" and lost that segment on every
    // clean stop.
    expect(calls).toEqual(['planner', 'memory', 'accounts']);
  });

  it('keeps storage open for the final deposition', async () => {
    let storageOpen = true;
    let flushed = false;
    await stopServerRuntimes({
      stopPlanner: async () => undefined,
      stopMemory: async () => {
        if (!storageOpen) throw new Error('The database connection is not open');
        flushed = true;
      },
      shutdownAccounts: async () => { storageOpen = false; },
    });
    expect(flushed).toBe(true);
  });

  it('releases storage even when the deposition fails, then reports the failure', async () => {
    let accountsStopped = false;
    await expect(stopServerRuntimes({
      stopPlanner: async () => undefined,
      stopMemory: async () => { throw new Error('sidecar unreachable'); },
      shutdownAccounts: async () => { accountsStopped = true; },
    })).rejects.toThrow('did not complete cleanly');
    expect(accountsStopped).toBe(true);
  });
});
