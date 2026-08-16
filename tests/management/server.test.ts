import { randomBytes } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ManagementServer } from '../../src/management/server.js';
import { WebAuthService } from '../../src/management/web-auth.js';

interface TestSession {
  initialize(): void;
  subscribe(listener: (snapshot: { output: string[]; currentTaskId: string | null }) => void): () => void;
  submit(): Promise<{ exitRequested: boolean }>;
  dispose(): Promise<void>;
}

class RawWebSocketClient {
  private buffer = Buffer.alloc(0);
  private readonly waiters: Array<{
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(readonly socket: Socket) {
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk as Buffer]);
      this.flush();
    });
    socket.on('close', () => this.rejectAll(new Error('socket closed')));
    socket.on('error', error => this.rejectAll(error));
  }

  sendJson(value: unknown): void {
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    const mask = randomBytes(4);
    const header = payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  nextText(timeoutMs = 1_000): Promise<string> {
    const existing = this.readTextFrame();
    if (existing !== null) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex(waiter => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('timeout waiting for WebSocket text frame'));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private flush(): void {
    while (this.waiters.length > 0) {
      const text = this.readTextFrame();
      if (text === null) return;
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve(text);
    }
  }

  private readTextFrame(): string | null {
    if (this.buffer.length < 2) return null;
    const opcode = this.buffer[0]! & 0x0f;
    let length = this.buffer[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return null;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    }
    if (this.buffer.length < offset + length) return null;
    const payload = this.buffer.subarray(offset, offset + length);
    this.buffer = this.buffer.subarray(offset + length);
    if (opcode !== 0x1) return this.readTextFrame();
    return payload.toString('utf8');
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

describe('ManagementServer WebSocket authentication', () => {
  it('broadcasts execution data only to authenticated connections', async () => {
    const port = await reservePort();
    const server = createManagementServer(port);
    await server.start();
    const cookie = await exchangeToken(port, 'manual-token');
    const authenticated = await connectWebSocket(
      port,
      `http://127.0.0.1:${port}`,
      cookie,
    );

    try {
      await expect(authenticated.nextText()).resolves.toContain('"type":"hello"');
      await expect(requestUpgrade(port, `http://127.0.0.1:${port}`)).resolves.toBe(401);

      (server as unknown as { broadcast(message: unknown): void }).broadcast({
        type: 'execution',
        taskId: 'task-secret',
      });

      await expect(authenticated.nextText()).resolves.toContain('"taskId":"task-secret"');
    } finally {
      authenticated.close();
      await server.stop();
    }
  });

  it('issues a session cookie and consumes the automatic bootstrap token once', async () => {
    const port = await reservePort();
    const server = createManagementServer(port);
    await server.start();

    try {
      const first = await exchangeTokenResponse(port, 'bootstrap-token');
      expect(first.status).toBe(204);
      expect(first.headers.get('set-cookie')).toContain(
        'anyfusion_web_session=session-token; HttpOnly; SameSite=Strict; Path=/',
      );
      const reused = await exchangeTokenResponse(port, 'bootstrap-token');
      expect(reused.status).toBe(401);

      const cookie = first.headers.get('set-cookie')!.split(';', 1)[0]!;
      const config = await fetch(`http://127.0.0.1:${port}/api/config`, {
        headers: { cookie },
      });
      expect(config.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('rejects credential exchange from a foreign browser origin', async () => {
    const port = await reservePort();
    const server = createManagementServer(port);
    await server.start();

    try {
      const response = await exchangeTokenResponse(
        port,
        'manual-token',
        'https://attacker.example',
      );
      expect(response.status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  it('rejects browser WebSocket upgrades from a foreign origin', async () => {
    const port = await reservePort();
    const server = createManagementServer(port);
    await server.start();

    try {
      const status = await requestUpgrade(port, 'https://attacker.example');
      expect(status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  it('rejects WebSocket upgrades without a session Cookie', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, 20);
    await server.start();

    try {
      await expect(requestUpgrade(port, `http://127.0.0.1:${port}`)).resolves.toBe(401);
    } finally {
      await server.stop();
    }
  });

  it('distinguishes the running revision from the next-start active revision', async () => {
    const port = await reservePort();
    const server = createManagementServer(port);
    await server.start();

    try {
      const configResponse = await fetch(`http://127.0.0.1:${port}/api/config`, {
        headers: { authorization: 'Bearer manual-token' },
      });
      await expect(configResponse.json()).resolves.toMatchObject({
        revisionId: 'revision-test',
        runningRevisionId: 'revision-runtime',
      });

      const activationResponse = await fetch(
        `http://127.0.0.1:${port}/api/config/activate`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer manual-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            baseRevisionId: 'revision-test',
            config: {},
          }),
        },
      );
      await expect(activationResponse.json()).resolves.toMatchObject({
        ok: true,
        revisionId: 'revision-next',
        activeRevisionId: 'revision-next',
        runningRevisionId: 'revision-runtime',
        restartRequired: true,
      });
    } finally {
      await server.stop();
    }
  });
});

function createManagementServer(
  port: number,
  webSocketAuthTimeoutMs?: number,
): ManagementServer {
  const session = {
    initialize() {},
    subscribe(listener) {
      listener({ output: [], currentTaskId: null });
      return () => {};
    },
    async submit() {
      return { exitRequested: false };
    },
    async dispose() {},
  } satisfies TestSession;
  const webAuth = new WebAuthService({
    bootstrapToken: 'bootstrap-token',
    manualAccessToken: 'manual-token',
    sessionToken: 'session-token',
  });
  return new ManagementServer({
    port,
    webDistDir: '/tmp/anyfusion-missing-web-dist',
    token: webAuth.manualAccessToken,
    webAuth,
    runningRevisionId: 'revision-runtime',
    webSocketAuthTimeoutMs,
    sessionFactory: () => session as never,
    executionQuery: {
      listTasks: () => [],
      projectTimeline: () => null,
    },
    configQuery: {
      getActive: async () => ({ revisionId: 'revision-test', contentHash: 'sha256:test', config: {} }),
      listRevisions: async () => [],
      getSnapshot: async () => null,
      activate: async () => ({ ok: true, revisionId: 'revision-next' }),
      rollback: async () => ({ ok: true, revisionId: 'revision-test' }),
    },
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

async function connectWebSocket(
  port: number,
  origin: string,
  cookie?: string,
): Promise<RawWebSocketClient> {
  const socket = createConnection({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(upgradeRequest(port, origin, cookie));
  const { status, rest } = await readUpgradeResponse(socket);
  if (status !== 101) {
    socket.destroy();
    throw new Error(`WebSocket upgrade failed with ${status}`);
  }
  const client = new RawWebSocketClient(socket);
  if (rest.length > 0) socket.emit('data', rest);
  return client;
}

async function requestUpgrade(port: number, origin: string): Promise<number> {
  const socket = createConnection({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(upgradeRequest(port, origin));
  const { status } = await readUpgradeResponse(socket);
  socket.destroy();
  return status;
}

function upgradeRequest(port: number, origin: string, cookie?: string): string {
  return [
    'GET /ws HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    `Origin: ${origin}`,
    ...(cookie ? [`Cookie: ${cookie}`] : []),
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
    '',
    '',
  ].join('\r\n');
}

async function exchangeToken(port: number, token: string): Promise<string> {
  const response = await exchangeTokenResponse(port, token);
  if (response.status !== 204) throw new Error(`exchange failed with ${response.status}`);
  return response.headers.get('set-cookie')!.split(';', 1)[0]!;
}

function exchangeTokenResponse(
  port: number,
  token: string,
  origin = `http://127.0.0.1:${port}`,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/auth/bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
    },
    body: JSON.stringify({ token }),
  });
}

function readUpgradeResponse(socket: Socket): Promise<{ status: number; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      cleanup();
      const firstLine = buffer.subarray(0, end).toString('utf8').split('\r\n')[0] ?? '';
      const status = Number(firstLine.split(' ')[1]);
      resolve({ status, rest: buffer.subarray(end + 4) });
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed before upgrade response'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}
