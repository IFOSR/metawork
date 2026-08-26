import { describe, expect, it, vi } from 'vitest';
import { ServerLifecycle } from '../../src/server/server-lifecycle.js';

describe('ServerLifecycle', () => {
  it('starts recovery and listeners before publishing ready and manifest', async () => {
    const calls: string[] = [];
    const lifecycle = new ServerLifecycle({
      acquireLock: async () => {
        calls.push('lock');
        return async () => calls.push('unlock');
      },
      recover: async () => calls.push('recover'),
      startListeners: async () => {
        calls.push('listeners');
        return { unixSocketPath: '/tmp/gateway.sock', webOrigin: 'http://127.0.0.1:8788' };
      },
      writeManifest: async () => calls.push('manifest'),
      markDraining: async () => calls.push('draining'),
      stopListeners: async () => calls.push('stop-listeners'),
      drain: async () => calls.push('drain'),
      stopRuntime: async () => calls.push('stop-runtime'),
      removeManifest: async () => calls.push('remove-manifest'),
    });

    await lifecycle.start();
    expect(calls).toEqual(['lock', 'recover', 'listeners', 'manifest']);
    expect(lifecycle.state).toBe('ready');
  });

  it('drains before Runtime shutdown and releases the lock only at the end', async () => {
    const calls: string[] = [];
    const unlock = vi.fn(async () => calls.push('unlock'));
    const lifecycle = new ServerLifecycle({
      acquireLock: async () => {
        calls.push('lock');
        return unlock;
      },
      recover: async () => calls.push('recover'),
      startListeners: async () => {
        calls.push('listeners');
        return { unixSocketPath: '/tmp/gateway.sock', webOrigin: 'http://127.0.0.1:8788' };
      },
      writeManifest: async () => calls.push('manifest'),
      markDraining: async () => calls.push('draining'),
      stopListeners: async () => calls.push('stop-listeners'),
      drain: async () => calls.push('drain'),
      stopRuntime: async () => calls.push('stop-runtime'),
      removeManifest: async () => calls.push('remove-manifest'),
    });

    await lifecycle.start();
    await lifecycle.stop();
    expect(calls).toEqual([
      'lock',
      'recover',
      'listeners',
      'manifest',
      'draining',
      'stop-listeners',
      'drain',
      'stop-runtime',
      'remove-manifest',
      'unlock',
    ]);
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(lifecycle.state).toBe('stopped');
  });

  it('cleans up a partial startup and never publishes a ready manifest', async () => {
    const calls: string[] = [];
    const lifecycle = new ServerLifecycle({
      acquireLock: async () => {
        calls.push('lock');
        return async () => calls.push('unlock');
      },
      recover: async () => {
        calls.push('recover');
        throw new Error('recovery failed');
      },
      startListeners: async () => {
        calls.push('listeners');
        return { unixSocketPath: '/tmp/gateway.sock', webOrigin: 'http://127.0.0.1:8788' };
      },
      writeManifest: async () => calls.push('manifest'),
      stopListeners: async () => calls.push('stop-listeners'),
      drain: async () => calls.push('drain'),
      stopRuntime: async () => calls.push('stop-runtime'),
      removeManifest: async () => calls.push('remove-manifest'),
    });

    await expect(lifecycle.start()).rejects.toThrow('recovery failed');
    expect(calls).toEqual(['lock', 'recover', 'remove-manifest', 'unlock']);
    expect(lifecycle.state).toBe('failed');
  });

  it('stops listeners and runtime when ready publication fails', async () => {
    const calls: string[] = [];
    const lifecycle = new ServerLifecycle({
      acquireLock: async () => {
        calls.push('lock');
        return async () => calls.push('unlock');
      },
      recover: async () => calls.push('recover'),
      startListeners: async () => {
        calls.push('listeners');
        return { unixSocketPath: '/tmp/gateway.sock', webOrigin: 'http://127.0.0.1:8788' };
      },
      writeManifest: async () => {
        calls.push('manifest');
        throw new Error('manifest failed');
      },
      markDraining: async () => calls.push('draining'),
      stopListeners: async () => calls.push('stop-listeners'),
      drain: async () => calls.push('drain'),
      stopRuntime: async () => calls.push('stop-runtime'),
      removeManifest: async () => calls.push('remove-manifest'),
    });

    await expect(lifecycle.start()).rejects.toThrow('manifest failed');
    expect(calls).toEqual([
      'lock',
      'recover',
      'listeners',
      'manifest',
      'stop-listeners',
      'drain',
      'stop-runtime',
      'remove-manifest',
      'unlock',
    ]);
  });
});
