import { randomBytes } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  ManagementServer,
  type ConfigQuery,
  type ManagementWebSessionRuntime,
} from '../../src/management/server.js';
import { WebAuthService } from '../../src/management/web-auth.js';
import type { WebSessionRecord } from '../../src/management/web-session-types.js';

function metadataFixture(id: string, active: boolean) {
  return {
    id,
    title: id,
    createdAt: '2026-08-17T08:00:00.000Z',
    updatedAt: '2026-08-17T08:00:00.000Z',
    active,
    archived: false,
  };
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
  it('stops accepting connections before waiting for the session runtime to dispose', async () => {
    const port = await reservePort();
    const disposal = deferred<void>();
    let disposeCalls = 0;
    const server = createManagementServer(port, {
      sessionRuntime: createSessionRuntime({
        dispose: async () => {
          disposeCalls += 1;
          await disposal.promise;
        },
      }),
    });
    await server.start();

    const firstStop = server.stop();
    const secondStop = server.stop();
    try {
      expect(await canConnect(port)).toBe(false);
      expect(disposeCalls).toBe(1);
    } finally {
      disposal.resolve();
      await Promise.all([firstStop, secondStop]);
    }
  });

  it('submits WebSocket input only through the required session runtime', async () => {
    const port = await reservePort();
    const submitted: string[] = [];
    const listeners = new Set<Parameters<ManagementWebSessionRuntime['subscribe']>[0]>();
    const sessionRuntime = createSessionRuntime({
      activeSessionId: 'session_gateway',
      submit: async text => {
        submitted.push(text);
        for (const listener of listeners) {
          listener({ type: 'output', from: 0, lines: ['Final answer'] });
        }
      },
      subscribe: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const server = createManagementServer(port, { sessionRuntime });
    await server.start();
    const cookie = await exchangeToken(port, 'manual-token');
    const client = await connectWebSocket(port, `http://127.0.0.1:${port}`, cookie);

    try {
      expect(JSON.parse(await client.nextText())).toEqual({
        type: 'hello',
        sessionId: 'session_gateway',
      });
      client.sendJson({ type: 'input', text: 'Show the flow' });
      await expect(client.nextText()).resolves.toBe(JSON.stringify({
        type: 'output',
        from: 0,
        lines: ['Final answer'],
      }));
      expect(submitted).toEqual(['Show the flow']);
    } finally {
      client.close();
      await server.stop();
    }
  });

  it('broadcasts active-session changes from the runtime to every connected client', async () => {
    const port = await reservePort();
    const listeners = new Set<Parameters<ManagementWebSessionRuntime['subscribe']>[0]>();
    const sessionRuntime: ManagementWebSessionRuntime = {
      activeSessionId: 'session_live',
      async initialize() {},
      async dispose() {},
      async submit() {},
      async listSessions() {
        return [];
      },
      async readSession() {
        return null;
      },
      async createSession() {
        throw new Error('not used');
      },
      async activateSession() {
        return { state: 'active', sessionId: 'session_live' };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getReplayEvents: () => [],
    };
    const server = createManagementServer(port, { sessionRuntime });
    await server.start();
    const cookie = await exchangeToken(port, 'manual-token');
    const first = await connectWebSocket(port, `http://127.0.0.1:${port}`, cookie);
    const second = await connectWebSocket(port, `http://127.0.0.1:${port}`, cookie);

    try {
      await expect(first.nextText()).resolves.toContain('"sessionId":"session_live"');
      await expect(second.nextText()).resolves.toContain('"sessionId":"session_live"');
      for (const listener of listeners) {
        listener({ type: 'active_session_changed', sessionId: 'session_history' });
      }
      const expected = JSON.stringify({
        type: 'active_session_changed',
        sessionId: 'session_history',
      });
      await expect(first.nextText()).resolves.toBe(expected);
      await expect(second.nextText()).resolves.toBe(expected);
    } finally {
      first.close();
      second.close();
      await server.stop();
    }
  });

  it('exposes session list, history, creation, and structured activation results', async () => {
    const port = await reservePort();
    const live = metadataFixture('session_live', true);
    const history = metadataFixture('session_history', false);
    const historyRecord: WebSessionRecord = {
      version: 1,
      session: history,
      turns: [],
    };
    const sessionRuntime: ManagementWebSessionRuntime = {
      activeSessionId: 'session_live',
      async initialize() {},
      async dispose() {},
      async submit() {},
      async listSessions(query) {
        return query === 'history' ? [history] : [live, history];
      },
      async readSession(sessionId) {
        return sessionId === 'session_history' ? historyRecord : null;
      },
      async createSession(title) {
        const session: WebSessionRecord = {
          version: 1,
          session: { ...metadataFixture('session_new', false), title: title ?? 'New session' },
          turns: [],
        };
        return {
          session,
          activation: {
            state: 'activation_blocked',
            sessionId: 'session_new',
            reason: 'task_runtime_active',
          },
        };
      },
      async activateSession(sessionId) {
        return {
          state: 'activation_blocked',
          sessionId,
          reason: 'planner_turn_active',
        };
      },
      subscribe() {
        return () => {};
      },
      getReplayEvents: () => [],
    };
    const server = createManagementServer(port, { sessionRuntime });
    await server.start();

    try {
      const headers = {
        authorization: 'Bearer manual-token',
        'content-type': 'application/json',
      };
      const list = await fetch(
        `http://127.0.0.1:${port}/api/sessions?q=history`,
        { headers },
      );
      expect(await list.json()).toEqual({
        activeSessionId: 'session_live',
        sessions: [history],
      });

      const record = await fetch(
        `http://127.0.0.1:${port}/api/sessions/session_history`,
        { headers },
      );
      expect(await record.json()).toEqual(historyRecord);

      const created = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'New research' }),
      });
      expect(await created.json()).toMatchObject({
        session: { session: { id: 'session_new', title: 'New research' } },
        activation: {
          state: 'activation_blocked',
          reason: 'task_runtime_active',
        },
      });

      const activated = await fetch(
        `http://127.0.0.1:${port}/api/sessions/session_history/activate`,
        { method: 'POST', headers },
      );
      expect(await activated.json()).toEqual({
        state: 'activation_blocked',
        sessionId: 'session_history',
        reason: 'planner_turn_active',
      });
    } finally {
      await server.stop();
    }
  });

  it('replays trace events on connect and streams ordered deltas while a turn is running', async () => {
    const port = await reservePort();
    const firstEvent = {
        id: 'interaction:turn-trace:query_received:query',
        sequence: 1,
        occurredAt: '2026-08-17T00:00:00.000Z',
        phase: 'intake',
        actor: 'user',
        kind: 'query_received',
        status: 'completed',
        title: 'User query received',
        summary: 'Show the process',
        details: {},
      } as const;
    const traceListeners = new Set<Parameters<ManagementWebSessionRuntime['subscribe']>[0]>();
    const sessionRuntime = createSessionRuntime({
      activeSessionId: 'sess_web_trace',
      getReplayEvents: () => [{
        type: 'trace_delta',
        turnId: 'turn-trace',
        fromSequence: 1,
        events: [firstEvent],
      }],
      subscribe(listener) {
        traceListeners.add(listener);
        return () => traceListeners.delete(listener);
      },
    });
    const server = createManagementServer(port, { sessionRuntime });
    await server.start();
    const cookie = await exchangeToken(port, 'manual-token');
    const first = await connectWebSocket(port, `http://127.0.0.1:${port}`, cookie);

    try {
      await expect(first.nextText()).resolves.toContain('"type":"hello"');
      await expect(first.nextText()).resolves.toBe(JSON.stringify({
        type: 'trace_delta',
        turnId: 'turn-trace',
        fromSequence: 1,
        events: [firstEvent],
      }));
      const secondEvent = {
          id: 'interaction:turn-trace:planner_started:planner',
          sequence: 2,
          occurredAt: '2026-08-17T00:00:01.000Z',
          phase: 'planning',
          actor: 'planner',
          kind: 'planner_started',
          status: 'running',
          title: 'Planner started',
          summary: 'Planning',
          details: {},
        } as const;
      for (const listener of traceListeners) {
        listener({
          type: 'trace_delta',
          turnId: 'turn-trace',
          fromSequence: 2,
          events: [secondEvent],
        });
      }
      await expect(first.nextText()).resolves.toBe(JSON.stringify({
        type: 'trace_delta',
        turnId: 'turn-trace',
        fromSequence: 2,
        events: [secondEvent],
      }));

      const second = await connectWebSocket(port, `http://127.0.0.1:${port}`, cookie);
      try {
        await expect(second.nextText()).resolves.toContain('"type":"hello"');
        await expect(second.nextText()).resolves.toBe(JSON.stringify({
          type: 'trace_delta',
          turnId: 'turn-trace',
          fromSequence: 1,
          events: [firstEvent],
        }));
      } finally {
        second.close();
      }
    } finally {
      first.close();
      await server.stop();
    }
  });

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
    const server = createManagementServer(port, { webSocketAuthTimeoutMs: 20 });
    await server.start();

    try {
      await expect(requestUpgrade(port, `http://127.0.0.1:${port}`)).resolves.toBe(401);
    } finally {
      await server.stop();
    }
  });

  it('explains a WebSocket origin mismatch through the diagnostic endpoint', async () => {
    const port = await reservePort();
    const server = createManagementServer(port);
    await server.start();

    try {
      const cookie = await exchangeToken(port, 'manual-token');
      const response = await fetch(`http://127.0.0.1:${port}/api/ws/diagnostics`, {
        headers: {
          cookie,
          origin: 'http://127.0.0.1:5173',
        },
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: 'forbidden_origin',
        message: 'WebSocket Origin 与服务端端口不匹配。',
      });
    } finally {
      await server.stop();
    }
  });

  it('reports an authenticated WebSocket as ready for the current origin', async () => {
    const port = await reservePort();
    const server = createManagementServer(port);
    await server.start();

    try {
      const cookie = await exchangeToken(port, 'manual-token');
      const response = await fetch(`http://127.0.0.1:${port}/api/ws/diagnostics`, {
        headers: {
          cookie,
          origin: `http://127.0.0.1:${port}`,
        },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        reason: 'ready',
        message: 'WebSocket 可以连接。',
      });
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

  it('writes a provider secret and never echoes the plaintext back', async () => {
    const port = await reservePort();
    let storedApiKey = '';
    const server = createManagementServer(port, {
      configQuery: {
        writeSecret: async (_ref, apiKey) => {
          storedApiKey = apiKey;
          return { apiKeyRef: 'file-secret:anyfusion/providers/provider-test' };
        },
      },
    });
    await server.start();

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${port}/api/config/secrets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerRef: 'provider-test', apiKey: 'sk-secret' }),
      });
      expect(unauthorized.status).toBe(401);

      const response = await fetch(`http://127.0.0.1:${port}/api/config/secrets`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer manual-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ providerRef: 'provider-test', apiKey: 'sk-secret' }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ apiKeyRef: 'file-secret:anyfusion/providers/provider-test' });
      expect(storedApiKey).toBe('sk-secret');
      expect(JSON.stringify(body)).not.toContain('sk-secret');
    } finally {
      await server.stop();
    }
  });

  it('tags output increments with stable absolute cursors so reconnects dedupe by index', async () => {
    const port = await reservePort();
    const listeners = new Set<Parameters<ManagementWebSessionRuntime['subscribe']>[0]>();
    const replay = [{ type: 'output', from: 0, lines: ['第一行', '第二行'] }] as const;
    const sessionRuntime = createSessionRuntime({
      getReplayEvents: () => structuredClone(replay),
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    const server = createManagementServer(port, { sessionRuntime });
    await server.start();
    const cookie = await exchangeToken(port, 'manual-token');
    const first = await connectWebSocket(port, `http://127.0.0.1:${port}`, cookie);

    try {
      await expect(first.nextText()).resolves.toContain('"type":"hello"');
      // 新连接拿到 from=0 的全量回放。
      await expect(first.nextText()).resolves.toBe(
        JSON.stringify({ type: 'output', from: 0, lines: ['第一行', '第二行'] }),
      );

      // 后续增量携带绝对游标。
      for (const listener of listeners) {
        listener({ type: 'output', from: 2, lines: ['第三行'] });
      }
      await expect(first.nextText()).resolves.toBe(
        JSON.stringify({ type: 'output', from: 2, lines: ['第三行'] }),
      );

      // 重连的新连接再次从 from=0 全量回放，客户端按下标幂等合并即无重复。
      const second = await connectWebSocket(port, `http://127.0.0.1:${port}`, cookie);
      try {
        await expect(second.nextText()).resolves.toContain('"type":"hello"');
        await expect(second.nextText()).resolves.toBe(
          JSON.stringify({ type: 'output', from: 0, lines: ['第一行', '第二行'] }),
        );
      } finally {
        second.close();
      }
    } finally {
      first.close();
      await server.stop();
    }
  });

  it('sends the current execution timeline to a freshly connected client', async () => {
    const port = await reservePort();
    const timeline = { taskId: 'task-live', title: 'demo', status: 'running', stages: [] };
    const sessionRuntime = createSessionRuntime({
      getReplayEvents: () => [{
        type: 'execution',
        taskId: 'task-live',
        timeline,
      }],
    });
    const server = createManagementServer(port, { sessionRuntime });
    await server.start();
    const cookie = await exchangeToken(port, 'manual-token');
    const client = await connectWebSocket(port, `http://127.0.0.1:${port}`, cookie);

    try {
      // 首条连接建立时投影过一次；第二条连接也要立刻拿到当前时间线。
      await expect(client.nextText()).resolves.toContain('"type":"hello"');
      await expect(client.nextText()).resolves.toBe(
        JSON.stringify({ type: 'execution', taskId: 'task-live', timeline }),
      );

      const second = await connectWebSocket(port, `http://127.0.0.1:${port}`, cookie);
      try {
        await expect(second.nextText()).resolves.toContain('"type":"hello"');
        await expect(second.nextText()).resolves.toBe(
          JSON.stringify({ type: 'execution', taskId: 'task-live', timeline }),
        );
      } finally {
        second.close();
      }
    } finally {
      client.close();
      await server.stop();
    }
  });
});

interface ManagementServerTestOverrides {
  readonly webSocketAuthTimeoutMs?: number;
  readonly sessionRuntime?: ManagementWebSessionRuntime;
  readonly executionQuery?: { listTasks(): unknown[]; projectTimeline(taskId: string): unknown };
  readonly configQuery?: Partial<ConfigQuery>;
}

function createManagementServer(
  port: number,
  overrides: ManagementServerTestOverrides = {},
): ManagementServer {
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
    webSocketAuthTimeoutMs: overrides.webSocketAuthTimeoutMs,
    sessionRuntime: overrides.sessionRuntime ?? createSessionRuntime(),
    executionQuery: overrides.executionQuery ?? {
      listTasks: () => [],
      projectTimeline: () => null,
    },
    configQuery: {
      getActive: async () => ({ revisionId: 'revision-test', contentHash: 'sha256:test', config: {} }),
      listRevisions: async () => [],
      getSnapshot: async () => null,
      activate: async () => ({ ok: true, revisionId: 'revision-next' }),
      rollback: async () => ({ ok: true, revisionId: 'revision-test' }),
      writeSecret: async () => ({ apiKeyRef: 'file-secret:anyfusion/providers/provider-test' }),
      ...overrides.configQuery,
    },
  });
}

function createSessionRuntime(
  overrides: Partial<ManagementWebSessionRuntime> = {},
): ManagementWebSessionRuntime {
  return {
    activeSessionId: 'session_live',
    async initialize() {},
    async dispose() {},
    async submit() {},
    async listSessions() {
      return [];
    },
    async readSession() {
      return null;
    },
    async createSession() {
      throw new Error('not used');
    },
    async activateSession(sessionId) {
      return { state: 'active', sessionId };
    },
    subscribe() {
      return () => {};
    },
    getReplayEvents: () => [],
    ...overrides,
  };
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

async function canConnect(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
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
