import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  consumeShutdownMarker,
  isInstanceRunning,
  acquireInstanceLock,
  SERVER_SHUTDOWN_MARKER,
  readInstanceLock,
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

  it('writes the token-gated shutdown marker and waits for graceful exit on Windows', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    const lockPath = resolve(directory, 'runtime.lock');
    await writeFile(lockPath, '{"pid":"4242","startedAt":"2026-08-17T00:00:00.000Z","token":"tok-1"}\n');
    let running = true;
    const signals: Array<NodeJS.Signals | 0> = [];
    const written: Array<[string, string]> = [];

    const result = await stopInstanceForRestart(lockPath, {
      platform: 'win32',
      markerGraceMs: 100,
      signalProcess: (_pid: number, signal: NodeJS.Signals | 0) => {
        signals.push(signal);
        if (signal === 0 && !running) {
          const error = new Error('not running') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
        return true;
      },
      sleep: async () => undefined,
      writeShutdownMarker: async (markerPath, token) => {
        written.push([markerPath, token]);
        running = false; // Server honors the marker and exits gracefully.
      },
    });

    expect(result).toEqual({ status: 'stopped', pid: 4242 });
    expect(written).toEqual([[resolve(directory, SERVER_SHUTDOWN_MARKER), 'tok-1']]);
    expect(signals).toEqual([0, 0]); // aliveness probe + one grace poll, no signal
  });

  it('falls back to the signal path when the marker is not honored', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    const lockPath = resolve(directory, 'runtime.lock');
    await writeFile(lockPath, '{"pid":"4242","startedAt":"2026-08-17T00:00:00.000Z","token":"tok-1"}\n');
    let running = true;
    const signals: Array<NodeJS.Signals | 0> = [];

    const result = await stopInstanceForRestart(lockPath, {
      platform: 'win32',
      markerGraceMs: 100,
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
      writeShutdownMarker: async () => undefined, // old Server ignores the marker
    });

    expect(result).toEqual({ status: 'stopped', pid: 4242 });
    expect(signals).toEqual([0, 0, 'SIGTERM', 0]);
  });

  it('ignores locks without a token (older Server versions)', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    const lockPath = resolve(directory, 'runtime.lock');
    await writeFile(lockPath, '{"pid":"4242","startedAt":"2026-08-17T00:00:00.000Z"}\n');
    let running = true;
    const signals: Array<NodeJS.Signals | 0> = [];

    await stopInstanceForRestart(lockPath, {
      platform: 'win32',
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
      writeShutdownMarker: async () => {
        throw new Error('marker must not be written without a token');
      },
    });

    expect(signals).toEqual([0, 'SIGTERM', 0]);
  });
});

describe('consumeShutdownMarker', () => {
  it('shuts down only on a token match and consumes the marker', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    const markerPath = resolve(directory, SERVER_SHUTDOWN_MARKER);
    await writeFile(markerPath, '{"token":"tok-1"}\n');
    let requests = 0;

    await consumeShutdownMarker(markerPath, 'tok-2', () => {
      requests += 1;
    });
    expect(requests).toBe(0);

    await consumeShutdownMarker(markerPath, 'tok-1', () => {
      requests += 1;
    });
    expect(requests).toBe(1);
    await expect(readFile(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(directory, { recursive: true, force: true });
  });
});

describe('zombie lock records', () => {
  it('reports a live instance lock with its start time', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    const lockPath = resolve(directory, 'runtime.lock');
    await writeFile(lockPath, '{"pid":"4242","startedAt":"2026-08-17T00:00:00.000Z"}\n');
    await expect(readInstanceLock(lockPath)).resolves.toEqual({ pid: 4242, startedAt: '2026-08-17T00:00:00.000Z' });
  });

  it('reports nothing when the lock is absent or unparsable', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    const lockPath = resolve(directory, 'runtime.lock');
    await expect(readInstanceLock(lockPath)).resolves.toBeNull();
    await writeFile(lockPath, 'not-a-pid\n');
    await expect(readInstanceLock(lockPath)).resolves.toBeNull();
  });
});

describe('stopInstanceForRestart --force', () => {
  it('escalates to SIGKILL once the grace window expires', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    const lockPath = resolve(directory, 'runtime.lock');
    await writeFile(lockPath, '{"pid":"4242","startedAt":"2026-08-17T00:00:00.000Z"}\n');
    let running = true;
    const signals: Array<NodeJS.Signals | 0> = [];
    const result = await stopInstanceForRestart(lockPath, {
      force: true,
      timeoutMs: 100,
      pollIntervalMs: 10,
      signalProcess: (_pid: number, signal: NodeJS.Signals | 0) => {
        signals.push(signal);
        if (signal === 'SIGKILL') running = false;
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
    expect(signals).toContain('SIGKILL');
  });

  it('does not escalate without --force', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'anyfusion-lock-'));
    const lockPath = resolve(directory, 'runtime.lock');
    await writeFile(lockPath, '{"pid":"4242","startedAt":"2026-08-17T00:00:00.000Z"}\n');
    const signals: Array<NodeJS.Signals | 0> = [];
    await expect(stopInstanceForRestart(lockPath, {
      timeoutMs: 20,
      pollIntervalMs: 10,
      signalProcess: (_pid: number, signal: NodeJS.Signals | 0) => { signals.push(signal); return true; },
      sleep: async () => undefined,
    })).rejects.toThrow('--force');
    expect(signals).not.toContain('SIGKILL');
  });
});
