import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isInstanceRunning,
  removeInstanceLockOnExit,
  stopInstanceForRestart,
} from '../../src/management/lock.js';

describe('isInstanceRunning', () => {
  it('recognizes a live runtime lock record', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    const lockPath = resolve(directory, 'runtime.lock');
    await writeFile(
      lockPath,
      `{"pid":"${process.pid}","startedAt":"2026-08-19T00:00:00.000Z"}\n`,
    );

    await expect(isInstanceRunning(lockPath)).resolves.toBe(true);
  });
});

describe('removeInstanceLockOnExit', () => {
  it('is idempotent after normal shutdown already released the lock', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    const lockPath = resolve(directory, 'runtime.lock');
    await writeFile(lockPath, '{"pid":"4242","startedAt":"2026-08-27T00:00:00.000Z"}\n');

    removeInstanceLockOnExit(lockPath);

    expect(() => removeInstanceLockOnExit(lockPath)).not.toThrow();
  });
});

describe('stopInstanceForRestart', () => {
  it('signals the lock holder and waits for it to exit', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    const lockPath = resolve(directory, 'runtime.lock');
    await writeFile(lockPath, '{"pid":"4242","startedAt":"2026-08-17T00:00:00.000Z"}\n');
    let running = true;
    const signals: Array<NodeJS.Signals | 0> = [];

    const result = await stopInstanceForRestart(lockPath, {
      signalProcess: (_pid: number, signal: NodeJS.Signals | 0) => {
        signals.push(signal);
        if (signal === 'SIGTERM') running = false;
        if (signal === 0 && !running) {
          const error = new Error('not running') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
        return true;
      },
      sleep: async () => undefined,
    });

    expect(result).toEqual({ status: 'stopped', pid: 4242 });
    expect(signals).toEqual([0, 'SIGTERM', 0]);
  });
});
