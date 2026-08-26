import { describe, expect, it } from 'vitest';
import { createServerApplication } from '../../src/server/server-application.js';

describe('ServerApplication', () => {
  it('owns the persistent server lifecycle without selecting a client surface', async () => {
    const calls: string[] = [];
    const application = createServerApplication({
      startListeners: async () => {
        calls.push('listeners');
        return { unixSocketPath: '/tmp/gateway.sock', webOrigin: 'http://127.0.0.1:8788' };
      },
      stopListeners: async () => calls.push('stop-listeners'),
      drain: async () => calls.push('drain'),
      stopRuntime: async () => calls.push('stop-runtime'),
    }, {
      acquireLock: async () => {
        calls.push('lock');
        return async () => calls.push('unlock');
      },
      recover: async () => calls.push('recover'),
      writeManifest: async () => calls.push('manifest'),
      removeManifest: async () => calls.push('remove-manifest'),
    });

    await application.start();
    expect(application.state).toBe('ready');
    await application.stop();

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
