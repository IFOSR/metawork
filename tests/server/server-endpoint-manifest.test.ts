import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyServerReadiness,
  ENDPOINT_MANIFEST_VERSION,
  readEndpointManifest,
  removeEndpointManifest,
  validateEndpointManifest,
  writeEndpointManifest,
  type EndpointManifest,
} from '../../src/server/server-endpoint-manifest.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; path: string; manifest: EndpointManifest }> {
  const root = await mkdtemp(join(tmpdir(), 'metawork-manifest-'));
  roots.push(root);
  return {
    root,
    path: join(root, 'endpoint.json'),
    manifest: {
      manifestVersion: ENDPOINT_MANIFEST_VERSION,
      releaseId: '1.2.0-preview.0+build.1',
      serverVersion: '1.2.0',
      gatewayProtocolVersion: 2,
      pid: 1234,
      startedAt: '2026-08-26T00:00:00.000Z',
      state: 'ready',
      unixSocketPath: join(root, 'gateway.sock'),
      webOrigin: 'http://127.0.0.1:8788',
    },
  };
}

describe('server endpoint manifest', () => {
  it('reports ready only when a live instance has a valid ready endpoint', async () => {
    const value = await fixture();

    expect(classifyServerReadiness(value.manifest, true, {
      isProcessAlive: () => true,
      socketExists: () => true,
    })).toBe('ready');
    expect(classifyServerReadiness(null, true)).toBe('starting_or_failed');
    expect(classifyServerReadiness(value.manifest, true, {
      isProcessAlive: () => true,
      socketExists: () => false,
    })).toBe('starting_or_failed');
    expect(classifyServerReadiness(value.manifest, false)).toBe('not_running');
  });

  it('writes and reads an atomic mode-restricted manifest without Workspace data', async () => {
    const value = await fixture();
    await writeEndpointManifest(value.path, value.manifest);

    expect(await readEndpointManifest(value.path)).toEqual(value.manifest);
    expect(JSON.parse(await readFile(value.path, 'utf8'))).not.toHaveProperty('workspace');
    expect((await stat(value.path)).mode & 0o777).toBe(0o600);
  });

  it('rejects malformed, draining, stale, or protocol-incompatible manifests', async () => {
    const value = await fixture();
    expect(validateEndpointManifest({ ...value.manifest, manifestVersion: 99 })).toMatchObject({
      ok: false,
      code: 'manifest_version_mismatch',
    });
    expect(validateEndpointManifest({ ...value.manifest, state: 'draining' })).toMatchObject({
      ok: false,
      code: 'server_draining',
    });
    expect(validateEndpointManifest(value.manifest, {
      protocolVersion: 1,
      isProcessAlive: () => true,
      socketExists: () => true,
    })).toMatchObject({
      ok: false,
      code: 'protocol_mismatch',
    });
    expect(validateEndpointManifest(value.manifest, {
      protocolVersion: 2,
      releaseId: '1.2.0-preview.0+build.2',
      isProcessAlive: () => true,
      socketExists: () => true,
    })).toMatchObject({
      ok: false,
      code: 'release_mismatch',
    });
    expect(validateEndpointManifest(value.manifest, {
      protocolVersion: 2,
      isProcessAlive: () => false,
      socketExists: () => true,
    })).toMatchObject({
      ok: false,
      code: 'server_not_running',
    });
    expect(validateEndpointManifest(value.manifest, {
      protocolVersion: 2,
      isProcessAlive: () => true,
      socketExists: () => false,
    })).toMatchObject({
      ok: false,
      code: 'socket_unavailable',
    });
  });

  it('removes the manifest during shutdown cleanup', async () => {
    const value = await fixture();
    await writeEndpointManifest(value.path, value.manifest);
    await chmod(value.path, 0o600);
    await removeEndpointManifest(value.path);
    await expect(readEndpointManifest(value.path)).resolves.toBeNull();
  });
});
