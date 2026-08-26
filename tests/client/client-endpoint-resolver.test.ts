import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ENDPOINT_MANIFEST_VERSION,
  writeEndpointManifest,
} from '../../src/server/server-endpoint-manifest.js';
import {
  resolveClientEndpoint,
  type ClientEndpointResolverDeps,
} from '../../src/client/client-endpoint-resolver.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('resolveClientEndpoint', () => {
  it('resolves a ready compatible Server endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-client-endpoint-'));
    roots.push(root);
    const manifestPath = join(root, 'endpoint.json');
    await writeEndpointManifest(manifestPath, {
      manifestVersion: ENDPOINT_MANIFEST_VERSION,
      serverVersion: '1.2.0',
      gatewayProtocolVersion: 1,
      pid: 123,
      startedAt: '2026-08-26T00:00:00.000Z',
      state: 'ready',
      unixSocketPath: join(root, 'gateway.sock'),
      webOrigin: 'http://127.0.0.1:8788',
    });
    const deps: ClientEndpointResolverDeps = {
      isProcessAlive: () => true,
      socketExists: () => true,
      socketProbe: async () => undefined,
    };

    await expect(resolveClientEndpoint(manifestPath, 1, deps)).resolves.toMatchObject({
      ok: true,
      manifestVersion: 1,
    });
  });

  it('returns an actionable server-start diagnostic when Server is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-client-endpoint-'));
    roots.push(root);

    await expect(resolveClientEndpoint(join(root, 'missing.json'), 1, {
      isProcessAlive: () => false,
      socketExists: () => false,
      socketProbe: async () => undefined,
    })).resolves.toEqual({
      ok: false,
      code: 'server_unavailable',
      message: 'MetaWork Server is unavailable; run `metawork server start`.',
    });
  });

  it('fails closed on protocol mismatch before a Client starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-client-endpoint-'));
    roots.push(root);
    const manifestPath = join(root, 'endpoint.json');
    await writeEndpointManifest(manifestPath, {
      manifestVersion: ENDPOINT_MANIFEST_VERSION,
      serverVersion: '1.2.0',
      gatewayProtocolVersion: 2,
      pid: 123,
      startedAt: '2026-08-26T00:00:00.000Z',
      state: 'ready',
      unixSocketPath: join(root, 'gateway.sock'),
      webOrigin: 'http://127.0.0.1:8788',
    });

    await expect(resolveClientEndpoint(manifestPath, 1, {
      isProcessAlive: () => true,
      socketExists: () => true,
      socketProbe: async () => undefined,
    })).resolves.toMatchObject({
      ok: false,
      code: 'protocol_mismatch',
    });
  });
});
