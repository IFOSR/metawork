import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
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
  it('waits through initial replay events for the Gateway hello', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-client-endpoint-'));
    roots.push(root);
    const manifestPath = join(root, 'endpoint.json');
    const socketPath = join(root, 'gateway.sock');
    const server = createServer(socket => {
      socket.write(`${JSON.stringify({
        type: 'event',
        event: {
          protocolVersion: 1,
          eventId: 'event_snapshot',
          sequence: 1,
          accountId: 'local-default',
          conversationId: 'conv_probe',
          requestId: null,
          turnId: null,
          kind: 'conversation_snapshot',
          payload: { workspace: null, from: 0, lines: [], truncated: false },
          occurredAt: '2026-08-27T00:00:00.000Z',
        },
      })}\n`);
      socket.end(`${JSON.stringify({
        type: 'hello',
        sessionId: 'conv_probe',
      })}\n`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await writeEndpointManifest(manifestPath, {
      manifestVersion: ENDPOINT_MANIFEST_VERSION,
      serverVersion: '1.2.0',
      gatewayProtocolVersion: 1,
      pid: process.pid,
      startedAt: '2026-08-27T00:00:00.000Z',
      state: 'ready',
      unixSocketPath: socketPath,
      webOrigin: 'http://127.0.0.1:8788',
    });

    try {
      await expect(resolveClientEndpoint(manifestPath, 1)).resolves.toMatchObject({
        ok: true,
        socketPath,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  });

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
