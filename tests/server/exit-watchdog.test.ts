import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { armExitWatchdog, DEFAULT_EXIT_WATCHDOG_MS, exitWatchdogTimeout } from '../../src/server/exit-watchdog.js';

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

function fakeSpawn() {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const spawn = vi.fn(() => child);
  return { spawn, child };
}

it('arms a detached watchdog that kills this process after the budget', () => {
  const { spawn, child } = fakeSpawn();
  armExitWatchdog({ pid: 4242, timeoutMs: 1234, spawn: spawn as never, execPath: '/fake/node' });
  expect(spawn).toHaveBeenCalledOnce();
  const [execPath, argv, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
  expect(execPath).toBe('/fake/node');
  expect(argv[0]).toBe('-e');
  expect(argv[1]).toContain('const pid=4242');
  expect(argv[1]).toContain('process.kill(pid,"SIGKILL")');
  expect(argv[1]).toContain('1234');
  expect(options).toMatchObject({ detached: true, stdio: 'ignore' });
  expect(child.unref).toHaveBeenCalledOnce();
});

it('defaults to the shutdown budget and honours the environment override', () => {
  expect(exitWatchdogTimeout({})).toBe(DEFAULT_EXIT_WATCHDOG_MS);
  expect(exitWatchdogTimeout({ METAWORK_EXIT_WATCHDOG_MS: '2500' })).toBe(2500);
  expect(exitWatchdogTimeout({ METAWORK_EXIT_WATCHDOG_MS: 'nonsense' })).toBe(DEFAULT_EXIT_WATCHDOG_MS);
  expect(exitWatchdogTimeout({ METAWORK_EXIT_WATCHDOG_MS: '-5' })).toBe(DEFAULT_EXIT_WATCHDOG_MS);
});

it('guards the kill with the process start time so a reused PID is safe', () => {
  const { spawn } = fakeSpawn();
  armExitWatchdog({ pid: 77, timeoutMs: 1000, spawn: spawn as never });
  const script = (spawn.mock.calls[0] as unknown as [string, string[]])[1][1]!;
  expect(script).toContain('lstart=');
  expect(script).toContain('identity()===stamp');
});

it('does nothing on Windows, where there is no POSIX signal or ps', () => {
  const { spawn } = fakeSpawn();
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  try {
    armExitWatchdog({ spawn: spawn as never });
  } finally { platform.mockRestore(); }
  expect(spawn).not.toHaveBeenCalled();
});

it('never lets a failed watchdog block shutdown', () => {
  const spawn = vi.fn(() => { throw new Error('spawn EMFILE'); });
  expect(() => armExitWatchdog({ spawn: spawn as never })).not.toThrow();
});
