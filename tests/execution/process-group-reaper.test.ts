import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  listProcessGroupMembers,
  processGroupAlive,
  reapProcessGroup,
} from '../../src/execution/process-group-reaper.js';

const posix = process.platform !== 'win32';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Spawn a group leader that leaves one background child and exits. */
async function leakedGroup(): Promise<{ pgid: number; childPid: number }> {
  const leader = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; exit 0'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const output = await new Promise<string>((resolve, reject) => {
    let text = '';
    leader.stdout?.on('data', chunk => { text += String(chunk); });
    leader.once('error', reject);
    leader.once('exit', () => resolve(text));
  });
  const childPid = Number(output.trim());
  expect(Number.isInteger(childPid)).toBe(true);
  return { pgid: leader.pid!, childPid };
}

describe('process group ownership', () => {
  it.skipIf(!posix)('reaps processes an Attempt leaves behind and records bounded facts', async () => {
    const { pgid, childPid } = await leakedGroup();
    try {
      expect(processGroupAlive(pgid)).toBe(true);
      expect(await listProcessGroupMembers(pgid)).toEqual([
        expect.objectContaining({ pid: childPid, command: 'sleep' }),
      ]);

      const result = await reapProcessGroup({ pgid, graceMs: 500, killWaitMs: 500 });

      expect(result.reaped).toBe(true);
      expect(result.signalled).toBe('SIGTERM');
      expect(result.members).toEqual([expect.objectContaining({ pid: childPid, command: 'sleep' })]);
      expect(pidAlive(childPid)).toBe(false);
      expect(processGroupAlive(pgid)).toBe(false);
    } finally {
      try { process.kill(-pgid, 'SIGKILL'); } catch { /* Group already gone. */ }
    }
  }, 20_000);

  it.skipIf(!posix)('does nothing when the group is already empty', async () => {
    const leader = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
    await new Promise(resolve => leader.once('exit', resolve));
    const result = await reapProcessGroup({ pgid: leader.pid!, graceMs: 500 });
    expect(result).toMatchObject({ members: [], signalled: 'none', reaped: true });
  });

  it('escalates SIGTERM to SIGKILL when a member ignores the first signal', async () => {
    const signals: string[] = [];
    let alive = true;
    const result = await reapProcessGroup({
      pgid: 4242,
      graceMs: 5,
      killWaitMs: 5,
      pollMs: 1,
      listMembers: async () => [{ pid: 4243, command: 'node' }],
      kill: (_pid, signal) => {
        signals.push(String(signal));
        if (signal === 'SIGKILL') alive = false;
        if (!alive) {
          const error = new Error('no such process') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
      },
    });
    // The exact poll count depends on timing; the escalation order does not.
    expect(signals.filter(signal => signal === 'SIGTERM')).toHaveLength(1);
    expect(signals.filter(signal => signal === 'SIGKILL')).toHaveLength(1);
    expect(signals.indexOf('SIGTERM')).toBeLessThan(signals.indexOf('SIGKILL'));
    expect(result).toMatchObject({ signalled: 'SIGKILL', reaped: true });
    expect(result.members).toEqual([{ pid: 4243, command: 'node' }]);
  });

  it('never signals Windows process ids', async () => {
    let signalled = false;
    const result = await reapProcessGroup({
      pgid: null,
      kill: () => { signalled = true; },
    });
    expect(result).toMatchObject({ signalled: 'none', reaped: true, members: [] });
    expect(signalled).toBe(false);
  });
});
