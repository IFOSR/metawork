import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestWindowsServerStop } from '../../src/client/windows-server-stop.js';
import type { ClientGateway } from '../../src/gateway/client-gateway.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { MetaclawGatewayServer } from '../../src/gateway/server.js';
import { resolveLocalEndpointPath } from '../../src/platform/local-endpoint.js';
import { loadWindowsPrivateFiles, type WindowsPrivateFiles } from '../../src/platform/windows-private-files.js';
import { ServerApplication } from '../../src/server/server-application.js';
import { ServerLifecycle } from '../../src/server/server-lifecycle.js';
import type { EndpointManifest } from '../../src/server/server-endpoint-manifest.js';

describe.skipIf(process.platform !== 'win32')('native Windows formal Server stop', () => {
  const modulePath = resolve('native/windows/build/Release/metawork_platform.node');
  let temporary: string;
  let root: string;
  let files: WindowsPrivateFiles;
  let server: MetaclawGatewayServer;
  let application: ServerApplication;
  let manifest: EndpointManifest;
  let failDrain: boolean;
  let steps: string[];
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'mw-stop-'));
    root = join(temporary, 'private');
    files = loadWindowsPrivateFiles(modulePath);
    files.ensurePrivateDirectory(root);
    failDrain = false;
    steps = [];
    const socketPath = resolveLocalEndpointPath(root, 'gateway.sock');
    manifest = { manifestVersion: 1, serverVersion: 'fixture', gatewayProtocolVersion: 2,
      pid: process.pid, startedAt: 'fixture-start', state: 'ready', unixSocketPath: socketPath, webOrigin: 'http://127.0.0.1:8788' };
    server = new MetaclawGatewayServer({ socketPath, windowsPipeModulePath: modulePath,
      gateway: { handle: vi.fn() } as unknown as ClientGateway, journal: new FileEventJournal(join(root, 'journal')),
      subscriptions: new GatewaySubscriptions(), authorizeAttach: async () => false,
      prepareServerStop: input => {
        if (input.startedAt !== 'fixture-start' || input.pid !== process.pid || application.state !== 'ready') throw new Error('identity');
        return () => {
          void application.stop().then(() => true, () => false).then(stopped => {
            files.writePrivateFile(root, 'server-stop-receipt.json', Buffer.from(JSON.stringify({
              nonce: input.nonce, pid: process.pid, startedAt: input.startedAt, stopped,
            })));
          });
        };
      },
    });
    application = new ServerApplication(new ServerLifecycle({
      acquireLock: async () => async () => { steps.push('release-lock'); }, recover: async () => undefined,
      startListeners: async () => { await server.start(); return { unixSocketPath: socketPath, webOrigin: manifest.webOrigin }; },
      writeManifest: async () => publish(),
      markDraining: async () => { steps.push('draining'); manifest = { ...manifest, state: 'draining' }; publish(); },
      stopListeners: async () => { steps.push('disconnect-clients'); await server.stop(); },
      drain: async () => { steps.push('drain'); if (failDrain) throw new Error('fixture drain failure'); },
      stopRuntime: async () => { steps.push('stop-runtime'); await new Promise(resolve => setTimeout(resolve, 75)); },
      removeManifest: async () => { steps.push('remove-endpoint'); await rm(join(root, 'server-endpoint.json')); },
    }));
    await application.start();
    // A previous Server's successful receipt must not satisfy this request.
    files.writePrivateFile(root, 'server-stop-receipt.json', Buffer.from(JSON.stringify({ stopped: true, nonce: '0'.repeat(64) })));
  });
  afterEach(async () => {
    await application?.stop().catch(() => undefined);
    await server?.stop();
    await rm(temporary, { recursive: true, force: true });
  });
  function publish() { files.writePrivateFile(root, 'server-endpoint.json', Buffer.from(JSON.stringify(manifest))); }
  function stop(expectedPid = process.pid) { return requestWindowsServerStop({ root, modulePath, releaseRoot: root, expectedPid }); }
  it('requires complete lifecycle cleanup and a matching receipt after acknowledgement', async () => {
    await stop();
    expect(application.state).toBe('stopped');
    expect(steps).toEqual(['draining', 'disconnect-clients', 'drain', 'stop-runtime', 'remove-endpoint', 'release-lock']);
  });
  it('reports drain failure even though listeners closed and the lock was released', async () => {
    failDrain = true;
    await expect(stop()).rejects.toThrow('did not complete cleanly');
    expect(steps.at(-1)).toBe('release-lock');
  });
  it('rejects stale process identity and lock/endpoint disagreement without stopping', async () => {
    await expect(stop(process.pid + 1)).rejects.toThrow('runtime lock');
    manifest = { ...manifest, startedAt: 'different-start' }; publish();
    await expect(stop()).rejects.toThrow('rejected');
    expect(application.state).toBe('ready');
    expect(steps).toEqual([]);
  });
});
