import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForStartedServer } from '../../src/client/server-readiness.js';
import { writeEndpointManifest, type EndpointManifest } from '../../src/server/server-endpoint-manifest.js';

const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mw-ready-'));
  roots.push(root);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  await once(child, 'spawn');
  const path = join(root, 'endpoint.json');
  const socket = join(root, 'gateway.sock');
  await writeFile(socket, 'socket-created-before-ready');
  const manifest: EndpointManifest = {
    manifestVersion: 1, serverVersion: '0.1.5', releaseId: 'candidate',
    gatewayProtocolVersion: 2, pid: child.pid!, startedAt: new Date().toISOString(),
    state: 'ready', unixSocketPath: socket, webOrigin: 'http://127.0.0.1:8788',
  };
  return { child, path, manifest };
}

describe('Server restart readiness', () => {
  it('waits beyond socket creation, stale PID, draining and wrong release until the new Server is ready', async () => {
    const value = await fixture();
    let settled = false;
    const ready = waitForStartedServer(value.child, value.path, { releaseId: 'candidate', timeoutMs: 3000 });
    void ready.then(() => { settled = true; });
    for (const manifest of [null, { ...value.manifest, pid: process.pid },
      { ...value.manifest, state: 'draining' as const }, { ...value.manifest, releaseId: 'old' }]) {
      if (manifest) await writeEndpointManifest(value.path, manifest);
      await setTimeout(150);
      expect(settled).toBe(false);
    }
    await writeEndpointManifest(value.path, value.manifest);
    await expect(ready).resolves.toEqual(value.manifest);
  });

  it('accepts the ready manifest on a named-pipe platform without checking for a socket file', async () => {
    const value = await fixture();
    value.manifest = { ...value.manifest, unixSocketPath: '\\\\.\\pipe\\metawork-readiness-fixture' };
    await writeEndpointManifest(value.path, value.manifest);
    await expect(waitForStartedServer(value.child, value.path)).resolves.toEqual(value.manifest);
  });

  it('rejects a child that exits before publishing readiness', async () => {
    const value = await fixture();
    const exited = once(value.child, 'exit');
    value.child.kill();
    await exited;
    await expect(waitForStartedServer(value.child, value.path)).rejects.toThrow('exited before');
  });

  it('times out instead of accepting an existing socket without a manifest', async () => {
    const value = await fixture();
    await expect(waitForStartedServer(value.child, value.path, { timeoutMs: 100 }))
      .rejects.toThrow('before the deadline');
  });
});
