import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagementApiServer } from '../../src/gateway/management-api-server.js';
import type { ServerHealthResponse } from '../../src/gateway/management-api-protocol.js';

function health(): ServerHealthResponse {
  return {
    schemaVersion: 1,
    status: 'ok',
    release: '1.2.0-preview.0',
    databaseSchema: 31,
    activeConfigurationRevision: 'revision-10',
    plannerProtocol: 'planning-agent-v7',
    kernelWorkflowAvailable: true,
    dispatchQuiesced: false,
    blockingRecovery: null,
  };
}

function request(socketPath: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        socket.end();
        resolve(JSON.parse(line) as Record<string, unknown>);
      }
    });
    socket.on('error', reject);
  });
}

describe('ManagementApiServer', () => {
  let server: ManagementApiServer | null = null;
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  async function startServer(): Promise<string> {
    tmpDir = mkdtempSync(join(tmpdir(), 'management-api-'));
    const socketPath = join(tmpDir, 'management.sock');
    server = new ManagementApiServer({ socketPath, health });
    await server.start();
    return socketPath;
  }

  it('serves /api/v1/server/health without leaking secrets', async () => {
    const socketPath = await startServer();

    const response = await request(socketPath, {
      id: 'req-1', method: 'GET', path: '/api/v1/server/health',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(health());
    expect(JSON.stringify(response.body)).not.toMatch(/key|secret|token|password/i);
  });

  it('rejects unknown routes with 404', async () => {
    const socketPath = await startServer();

    const response = await request(socketPath, {
      id: 'req-2', method: 'GET', path: '/api/v1/unknown',
    });

    expect(response.status).toBe(404);
    expect(response.error).toMatch(/unknown management route/);
  });
});
