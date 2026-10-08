import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ClientGateway } from '../../src/gateway/client-gateway.js';
import { DESKTOP_SESSION_CAPABILITY } from '../../src/gateway/desktop-session-contract.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { createJsonLineParser, encodeJsonLine } from '../../src/gateway/jsonl.js';
import { MetaclawGatewayServer } from '../../src/gateway/server.js';
import { DesktopSessionService } from '../../src/management/desktop-session.js';
import { resolveLocalEndpointPath } from '../../src/platform/local-endpoint.js';

describe('Desktop ticket transport admission', () => {
  it('never enables lifecycle control on ordinary Node transports', async () => {
    const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'mwd-stop-'));
    const path = resolveLocalEndpointPath(root, 'gateway.sock');
    const prepareServerStop = vi.fn(() => vi.fn());
    const server = new MetaclawGatewayServer({ socketPath: path,
      gateway: { handle: vi.fn() } as unknown as ClientGateway, journal: new FileEventJournal(join(root, 'journal')),
      subscriptions: new GatewaySubscriptions(), authorizeAttach: async () => false, prepareServerStop });
    let socket: ReturnType<typeof createConnection> | undefined;
    try {
      await server.start();
      const result = await new Promise<unknown>((resolve, reject) => {
        socket = createConnection(path);
        socket.setTimeout(3000, () => reject(new Error('Lifecycle denial timed out')));
        socket.on('error', reject);
        socket.on('data', createJsonLineParser<Record<string, unknown>>(message => {
          if (message.type !== 'hello') resolve(message);
        }, { maxFrameBytes: 4096, onError: reject }));
        socket.once('connect', () => socket!.write(encodeJsonLine({ type: 'request_server_stop',
          nonce: randomBytes(32).toString('hex'), pid: process.pid, startedAt: 'fixture' })));
      });
      expect(result).toEqual({ type: 'error', message: 'Server lifecycle control is unavailable' });
      expect(prepareServerStop).not.toHaveBeenCalled();
    } finally { socket?.destroy(); await server.stop(); await rm(root, { recursive: true, force: true }); }
  });
  it.each([true, false])('requires a supported OS-user transport and an issuer (%s)', async configured => {
    const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'mwdg-'));
    const path = resolveLocalEndpointPath(root, 'gateway.sock');
    const nonce = randomBytes(32).toString('hex');
    const service = new DesktopSessionService(() => ({
      installationId: 'a'.repeat(64), instanceId: 'fixture', accountId: 'local-default',
      releaseId: 'fixture', pid: process.pid, webOrigin: 'http://127.0.0.1:8788', gatewayProtocolVersion: 2,
    }));
    const issue = vi.fn((value: string, account: string) => service.issue(value, account));
    const server = new MetaclawGatewayServer({
      socketPath: path,
      gateway: { handle: vi.fn() } as unknown as ClientGateway,
      journal: new FileEventJournal(join(root, 'journal')),
      subscriptions: new GatewaySubscriptions(), authorizeAttach: async () => false,
      ...(configured ? { registerDesktopSession: issue } : {}),
    });
    let socket: ReturnType<typeof createConnection> | undefined;
    try {
      await server.start();
      const frames = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const messages: Record<string, unknown>[] = [];
        socket = createConnection(path);
        socket.setTimeout(5000, () => reject(new Error('Desktop admission did not respond')));
        socket.on('error', reject);
        socket.on('data', createJsonLineParser<Record<string, unknown>>(message => {
          messages.push(message);
          if (messages.length === 2) resolve(messages);
        }, { maxFrameBytes: 4096, onError: reject }));
        socket.once('connect', () => socket!.write(encodeJsonLine({ type: 'register_desktop_session', nonce })));
      });
      const permitted = configured && process.platform !== 'win32';
      expect(frames[0].type).toBe('hello');
      expect((frames[0].capabilities as string[]).includes(DESKTOP_SESSION_CAPABILITY)).toBe(permitted);
      if (permitted) {
        expect(frames[1].type).toBe('desktop_session_registered');
        expect(issue).toHaveBeenCalledWith(nonce, 'local-default');
      } else {
        expect(frames[1]).toEqual({ type: 'error', message: 'Desktop session is unavailable' });
        expect(issue).not.toHaveBeenCalled();
      }
    } finally {
      socket?.destroy();
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
