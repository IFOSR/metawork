import { describe, expect, it, vi } from 'vitest';
import {
  ServerUpdateCoordinator,
  type ServerUpdateCoordinatorDeps,
  type ServerUpdateResult,
} from '../../src/session/server-update-coordinator.js';

function makeDeps(overrides: {
  idle?: boolean;
  candidateOk?: boolean;
  leaseHeld?: boolean;
} = {}): { deps: ServerUpdateCoordinatorDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ServerUpdateCoordinatorDeps = {
    acquireLease: vi.fn(async () => {
      calls.push('acquireLease');
      return { held: overrides.leaseHeld ?? true, holder: 'update-1' };
    }),
    closeTaskAdmission: vi.fn(async () => { calls.push('closeTaskAdmission'); }),
    quiesceDispatch: vi.fn(async () => { calls.push('quiesceDispatch'); }),
    awaitIdle: vi.fn(async () => {
      calls.push('awaitIdle');
      return overrides.idle ?? true;
    }),
    stopSurfaces: vi.fn(async () => { calls.push('stopSurfaces'); }),
    closeDatabase: vi.fn(async () => { calls.push('closeDatabase'); }),
    startCandidate: vi.fn(async () => {
      calls.push('startCandidate');
      if (!(overrides.candidateOk ?? true)) throw new Error('candidate failed');
    }),
    restartPrevious: vi.fn(async () => { calls.push('restartPrevious'); }),
    openTaskAdmission: vi.fn(async () => { calls.push('openTaskAdmission'); }),
    releaseLease: vi.fn(async () => { calls.push('releaseLease'); }),
  };
  return { deps, calls };
}

describe('ServerUpdateCoordinator', () => {
  it('commits in order: quiesce → awaitIdle → stop → close → start → open', async () => {
    const { deps, calls } = makeDeps({ idle: true, candidateOk: true });
    const result = await new ServerUpdateCoordinator(deps).runUpdate(5_000);

    expect(result.outcome).toBe('committed');
    expect(calls).toEqual([
      'acquireLease',
      'closeTaskAdmission',
      'quiesceDispatch',
      'awaitIdle',
      'stopSurfaces',
      'closeDatabase',
      'startCandidate',
      'openTaskAdmission',
      'releaseLease',
    ]);
  });

  it('aborts on idle timeout and restarts the previous release', async () => {
    const { deps, calls } = makeDeps({ idle: false });
    const result = await new ServerUpdateCoordinator(deps).runUpdate(5_000);

    expect(result.outcome).toBe('timeout');
    expect(calls).toContain('restartPrevious');
    expect(calls).toContain('openTaskAdmission');
    expect(calls).not.toContain('startCandidate');
    expect(calls).not.toContain('closeDatabase');
  });

  it('restarts the previous release when the candidate fails to start', async () => {
    const { deps, calls } = makeDeps({ candidateOk: false });
    const result = await new ServerUpdateCoordinator(deps).runUpdate(5_000);

    expect(result.outcome).toBe('aborted');
    expect(calls).toContain('restartPrevious');
    expect(calls).toContain('openTaskAdmission');
  });

  it('returns early without side effects when the lease is not held', async () => {
    const { deps, calls } = makeDeps({ leaseHeld: false });
    const result = await new ServerUpdateCoordinator(deps).runUpdate(5_000);

    expect(result.outcome).toBe('aborted');
    expect(calls).toEqual(['acquireLease']);
  });

  it('allows only one in-flight update at a time', async () => {
    let resolveIdle: (value: boolean) => void = () => undefined;
    const gate = new Promise<boolean>(resolve => { resolveIdle = resolve; });
    const { deps } = makeDeps();
    (deps.awaitIdle as ReturnType<typeof vi.fn>).mockImplementation(() => gate);

    const coordinator = new ServerUpdateCoordinator(deps);
    const first = coordinator.runUpdate(5_000);
    const second = coordinator.runUpdate(5_000);

    resolveIdle(true);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(firstResult.outcome).toBe('committed');
    expect(deps.acquireLease).toHaveBeenCalledTimes(1);
  });

  it('always releases the lease, including on timeout', async () => {
    const { deps, calls } = makeDeps({ idle: false });
    await new ServerUpdateCoordinator(deps).runUpdate(5_000);

    expect(calls).toContain('releaseLease');
  });
});
