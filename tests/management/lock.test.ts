import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isInstanceRunning,
  acquireInstanceLock,
  stopInstanceForRestart,
} from '../../src/management/lock.js';
import { acquireRuntimeUpdateLock } from '../../src/installation/runtime-update-lock.js';

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

describe('instance lock ownership', () => {
  it('is idempotent after normal shutdown already released the lock', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    const lockPath = resolve(directory, 'runtime.lock');
    const lock = await acquireInstanceLock(lockPath);
    lock.releaseOnExit();
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await lock.release();
    expect(() => lock.releaseOnExit()).not.toThrow();
  });

  it('does not delete an update lock when the old Server exits after releasing', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    await mkdir(resolve(root, 'data'));
    const lockPath = resolve(root, 'data/runtime.lock');
    const server = await acquireInstanceLock(lockPath);
    await server.release();
    const update = await acquireRuntimeUpdateLock(root, 'update');
    const expected = await readFile(lockPath, 'utf8');
    server.releaseOnExit();
    await server.release();
    expect(await readFile(lockPath, 'utf8')).toBe(expected);
    await update.release();
  });

  it.each(['release', 'releaseOnExit'] as const)('preserves a replacement lock during %s even with the same PID', async method => {
    const root = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    const lockPath = resolve(root, 'runtime.lock');
    const old = await acquireInstanceLock(lockPath);
    await unlink(lockPath);
    const replacement = await acquireInstanceLock(lockPath);
    const expected = await readFile(lockPath, 'utf8');
    await old[method]();
    expect(await readFile(lockPath, 'utf8')).toBe(expected);
    await replacement.release();
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
