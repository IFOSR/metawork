import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverDesktopSession, requestDesktopSession } from '../../src/client/desktop-session-client.js';
import type { ClientGateway } from '../../src/gateway/client-gateway.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { MetaclawGatewayServer } from '../../src/gateway/server.js';
import { DesktopSessionService } from '../../src/management/desktop-session.js';
import { resolveLocalEndpointPath } from '../../src/platform/local-endpoint.js';
import { loadWindowsPrivateFiles, type WindowsPrivateFiles } from '../../src/platform/windows-private-files.js';
import type { EndpointManifest } from '../../src/server/server-endpoint-manifest.js';

describe.skipIf(process.platform !== 'win32')('native Windows Desktop Gateway authentication', () => {
  const modulePath = resolve('native/windows/build/Release/metawork_platform.node');
  let temporary: string;
  let root: string;
  let path: string;
  let files: WindowsPrivateFiles;
  let server: MetaclawGatewayServer;
  let service: DesktopSessionService;
  let manifest: EndpointManifest;
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'mw-gateway-'));
    root = join(temporary, '安装 root');
    files = loadWindowsPrivateFiles(modulePath);
    files.ensurePrivateDirectory(root);
    path = resolveLocalEndpointPath(root, 'gateway.sock');
    const identity = { installationId: createHash('sha256').update(await realpath(root)).digest('hex'),
      instanceId: 'fixture', accountId: 'local-default', releaseId: 'fixture', pid: process.pid,
      webOrigin: 'http://127.0.0.1:8788', gatewayProtocolVersion: 2 };
    service = new DesktopSessionService(() => identity);
    server = new MetaclawGatewayServer({ socketPath: path, windowsPipeModulePath: modulePath,
      gateway: { handle: vi.fn() } as unknown as ClientGateway,
      journal: new FileEventJournal(join(root, 'journal')), subscriptions: new GatewaySubscriptions(),
      authorizeAttach: async () => false, registerDesktopSession: (nonce, account) => service.issue(nonce, account) });
    await server.start();
    manifest = { manifestVersion: 1, releaseId: 'fixture', serverVersion: 'fixture', gatewayProtocolVersion: 2,
      pid: process.pid, startedAt: new Date().toISOString(), state: 'ready', unixSocketPath: path,
      webOrigin: identity.webOrigin };
    publish();
  });
  afterEach(async () => {
    await server?.stop();
    await rm(temporary, { recursive: true, force: true });
  });
  function publish(): void { files.writePrivateFile(root, 'endpoint.json', Buffer.from(JSON.stringify(manifest))); }
  function discover() {
    return discoverDesktopSession({ installRoot: root, manifestPath: join(root, 'endpoint.json'),
      releaseId: 'fixture', windowsModulePath: modulePath });
  }
  it('discovers the authenticated OS peer and issues single-use tickets across reconnects', async () => {
    for (let index = 0; index < 8; index++) {
      const grant = await discover();
      expect(grant.proof).toBe(service.proof(grant.nonce));
      const request = { ticket: grant.ticket, nonce: grant.nonce, instanceId: grant.instanceId };
      expect(service.consume(request)?.pid).toBe(process.pid);
      expect(service.consume(request)).toBeNull();
    }
    const grants = await Promise.all(Array.from({ length: 12 }, () => discover()));
    expect(new Set(grants.map(grant => grant.ticket)).size).toBe(12);
  }, 15000);
  it('rejects a manifest naming a different Server PID before issuing a ticket', async () => {
    manifest = { ...manifest, pid: process.pid + 1 }; publish();
    await expect(discover()).rejects.toThrow(/PID mismatch/u);
  });
  it('rejects release, origin, root-containment and missing native identity', async () => {
    manifest = { ...manifest, releaseId: 'other' }; publish();
    await expect(discover()).rejects.toThrow(/release mismatch/u);
    manifest = { ...manifest, releaseId: 'fixture', webOrigin: 'https://example.com' }; publish();
    await expect(discover()).rejects.toThrow(/origin/u);
    await expect(discoverDesktopSession({ installRoot: root, manifestPath: join(temporary, 'outside.json'),
      releaseId: 'fixture', windowsModulePath: modulePath })).rejects.toThrow();
    await expect(requestDesktopSession(path, randomBytes(32).toString('hex'))).rejects.toThrow(/native pipe identity/u);
  });
});
