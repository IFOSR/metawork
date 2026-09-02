import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ManagementServer,
  type ConfigQuery,
  type ManagementWebSessionRuntime,
} from '../../src/management/server.js';
import { WebAuthService } from '../../src/management/web-auth.js';
import { WebLaunchContextService } from '../../src/management/web-launch-context.js';
import { FileAttachmentStore } from '../../src/storage/file-attachment-store.js';
import {
  resolveLoginCredentials,
  type LoginCredentials,
} from '../../src/management/login-credentials.js';
import type { WebSessionRecordProjection } from '../../src/management/web-session-types.js';

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
  it('reports and serves the actual ephemeral port when configured with port zero', async () => {
    const server = createManagementServer(0);
    await server.start();

    try {
      expect(server.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(server.address).not.toBe('http://127.0.0.1:0');
      const response = await fetch(`${server.address}/api/auth/session`);
      expect(response.status).toBe(401);
    } finally {
      await server.stop();
    }
  });

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
    const listeners = new Set<(event: Parameters<Parameters<ManagementWebSessionRuntime['subscribe']>[1]>[0]) => void>();
    const sessionRuntime = createSessionRuntime({
      getClientState: () => ({ activeWorkspaceId: 'workspace_repo', activeSessionId: 'session_gateway' }),
      submit: async (_clientId, text) => {
        submitted.push(text);
        for (const listener of listeners) {
          listener({ type: 'output', from: 0, lines: ['Final answer'] });
        }
      },
      subscribe: (_clientId, listener) => {
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
    const listeners = new Set<(event: Parameters<Parameters<ManagementWebSessionRuntime['subscribe']>[1]>[0]) => void>();
    const sessionRuntime = createSessionRuntime({
      getClientState: () => ({ activeWorkspaceId: 'workspace_repo', activeSessionId: 'session_live' }),
      subscribe(_clientId, listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
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

  it('closes only the authenticated browser runtime and WebSockets on logout', async () => {
    const port = await reservePort();
    const closedClientIds: string[] = [];
    const sessionRuntime = createSessionRuntime({
      closeClient: async clientId => {
        closedClientIds.push(clientId);
      },
    });
    const server = createManagementServer(port, { sessionRuntime });
    await server.start();
    const firstCookie = await exchangeToken(port, 'manual-token');
    const secondCookie = await exchangeToken(port, 'manual-token');
    const first = await connectWebSocket(port, `http://127.0.0.1:${port}`, firstCookie);
    const second = await connectWebSocket(port, `http://127.0.0.1:${port}`, secondCookie);

    try {
      await expect(first.nextText()).resolves.toContain('"type":"hello"');
      await expect(second.nextText()).resolves.toContain('"type":"hello"');
      const logout = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
        method: 'POST',
        headers: {
          cookie: firstCookie,
          origin: `http://127.0.0.1:${port}`,
        },
      });
      expect(logout.status).toBe(204);
      expect(closedClientIds).toEqual(['session-token-1']);
      await expect(first.nextText()).rejects.toThrow('socket closed');

      second.sendJson({ type: 'input', text: 'still connected' });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(closedClientIds).toEqual(['session-token-1']);
    } finally {
      first.close();
      second.close();
      await server.stop();
    }
  });

  it('exposes Workspace-scoped Conversation list, detail, creation, and attach results', async () => {
    const port = await reservePort();
    const workspace = {
      id: 'workspace_repo',
      accountId: 'local-default',
      displayName: 'repo',
      canonicalPath: '/repo',
      availability: 'available' as const,
      createdAt: '2026-08-17T08:00:00.000Z',
      updatedAt: '2026-08-17T08:00:00.000Z',
      createdByPrincipal: 'web:manual-bearer-client',
      archived: false,
    };
    const history = { ...metadataFixture('session_history', false), workspace: null };
    const historyRecord: WebSessionRecordProjection = {
      version: 1,
      session: history,
      turns: [],
    };
    const sessionRuntime = createSessionRuntime({
      listWorkspaces: async () => [workspace],
      listSessions: async (_clientId, query) => {
        return query === 'history' ? [history] : [live, history];
      },
      readSession: async (_clientId, sessionId) => {
        return sessionId === 'session_history' ? historyRecord : null;
      },
      createSession: async () => {
        const session: WebSessionRecordProjection = {
          version: 1,
          session: {
            ...metadataFixture('session_new', false),
            title: 'New conversation',
            workspace: null,
          },
          turns: [],
        };
        return {
          session,
          activation: {
            state: 'activation_blocked',
            sessionId: 'session_new',
            reason: 'task_runtime_active',
          },
          workspaceInitialization: { status: 'not_requested' },
        };
      },
      activateSession: async (_clientId, sessionId) => {
        return {
          state: 'activation_blocked',
          sessionId,
          reason: 'planner_turn_active',
        };
      },
    });
    const server = createManagementServer(port, { sessionRuntime });
    await server.start();

    try {
      const headers = {
        authorization: 'Bearer manual-token',
        'content-type': 'application/json',
      };
      const workspaces = await fetch(
        `http://127.0.0.1:${port}/api/workspaces`,
        { headers },
      );
      expect(await workspaces.json()).toEqual({
        activeWorkspaceId: 'workspace_repo',
        workspaces: [workspace],
      });

      const list = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/workspace_repo/conversations?q=history`,
        { headers },
      );
      expect(await list.json()).toEqual({
        activeWorkspaceId: 'workspace_repo',
        activeConversationId: 'session_live',
        conversations: [history],
      });

      const record = await fetch(
        `http://127.0.0.1:${port}/api/conversations/session_history`,
        { headers },
      );
      expect(await record.json()).toEqual(historyRecord);

      const created = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/workspace_repo/conversations`,
        {
        method: 'POST',
        headers,
        },
      );
      expect(await created.json()).toMatchObject({
        session: { session: { id: 'session_new', title: 'New conversation' } },
        activation: {
          state: 'activation_blocked',
          reason: 'task_runtime_active',
        },
      });

      const activated = await fetch(
        `http://127.0.0.1:${port}/api/conversations/session_history/attach`,
        { method: 'POST', headers },
      );
      expect(await activated.json()).toEqual({
        state: 'activation_blocked',
        sessionId: 'session_history',
        reason: 'planner_turn_active',
      });

      const legacy = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers });
      expect(legacy.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it('archives a Conversation and clears non-active Conversations over HTTP', async () => {
    const port = await reservePort();
    const deletedIds: string[] = [];
    const clearedClientIds: string[] = [];
    const sessionRuntime = createSessionRuntime({
      deleteSession: async (_clientId, sessionId) => {
        deletedIds.push(sessionId);
        if (sessionId === 'session_active') return 'active';
        if (sessionId === 'session_missing') return 'not_found';
        return 'deleted';
      },
      clearAllSessions: async clientId => {
        clearedClientIds.push(clientId);
        return { deleted: 3 };
      },
    });
    const server = createManagementServer(port, { sessionRuntime });
    await server.start();

    try {
      const headers = { authorization: 'Bearer manual-token' };

      const deleted = await fetch(
        `http://127.0.0.1:${port}/api/conversations/session_done`,
        { method: 'DELETE', headers },
      );
      expect(deleted.status).toBe(204);
      expect(deletedIds).toEqual(['session_done']);

      const active = await fetch(
        `http://127.0.0.1:${port}/api/conversations/session_active`,
        { method: 'DELETE', headers },
      );
      expect(active.status).toBe(409);

      const missing = await fetch(
        `http://127.0.0.1:${port}/api/conversations/session_missing`,
        { method: 'DELETE', headers },
      );
      expect(missing.status).toBe(404);

      const unauthenticated = await fetch(
        `http://127.0.0.1:${port}/api/conversations/session_done`,
        { method: 'DELETE' },
      );
      expect(unauthenticated.status).toBe(401);

      const clear = await fetch(`http://127.0.0.1:${port}/api/conversations/clear-all`, {
        method: 'POST',
        headers,
      });
      expect(clear.status).toBe(200);
      expect(await clear.json()).toEqual({ deleted: 3 });
      expect(clearedClientIds).toEqual(['manual-bearer-client']);
    } finally {
      await server.stop();
    }
  });

  it('logs in with username and password, locks after repeated failures', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, {
      loginCredentials: resolveLoginCredentials({
        ANYFUSION_WEB_USERNAME: 'admin',
        ANYFUSION_WEB_PASSWORD: 'test-password',
      }),
    });
    await server.start();

    try {
      const loginUrl = `http://127.0.0.1:${port}/api/auth/login`;
      const login = (username: string, password: string) => fetch(loginUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ username, password }),
      });

      const bad = await login('admin', 'wrong');
      expect(bad.status).toBe(401);

      const missing = await login('admin', '');
      expect(missing.status).toBe(400);

      const ok = await login('admin', 'test-password');
      expect(ok.status).toBe(204);
      const cookie = ok.headers.get('set-cookie')!.split(';', 1)[0]!;
      expect(cookie).toContain('anyfusion_web_session=');

      // 会话 cookie 可访问受保护端点。
      const guarded = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
        headers: { cookie },
      });
      expect(guarded.status).toBe(200);
      const authSession = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
        headers: { cookie },
      });
      await expect(authSession.json()).resolves.toEqual({
        authenticated: true,
        launchContext: null,
      });

      // 连续失败 5 次后锁定（第 6 次即使密码正确也 429）。
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await login('admin', 'wrong');
      }
      const locked = await login('admin', 'test-password');
      expect(locked.status).toBe(429);
    } finally {
      await server.stop();
    }
  });

  it('returns 503 when password login credentials are not configured', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, { loginCredentials: undefined });
    await server.start();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ username: 'admin', password: 'whatever' }),
      });
      expect(response.status).toBe(503);
    } finally {
      await server.stop();
    }
  });

  it('uploads session attachments over authenticated binary POST', async () => {
    const port = await reservePort();
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-attachment-upload-'));
    const store = new FileAttachmentStore(join(root, 'attachments'));
    await store.initialize();
    const server = createManagementServer(port, { attachmentStore: store });
    await server.start();

    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    try {
      const headers = { authorization: 'Bearer manual-token' };

      const uploaded = await fetch(
        `http://127.0.0.1:${port}/api/attachments?sessionId=sess_web_abc&name=chart.png`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          body: PNG_MAGIC,
        },
      );
      expect(uploaded.status).toBe(201);
      const meta = await uploaded.json() as {
        attachmentId: string;
        kind: string;
        mime: string;
        sessionId: string;
      };
      expect(meta.kind).toBe('image');
      expect(meta.mime).toBe('image/png');
      expect(meta.sessionId).toBe('sess_web_abc');

      const unauthenticated = await fetch(
        `http://127.0.0.1:${port}/api/attachments?sessionId=s&name=a.png`,
        { method: 'POST', body: PNG_MAGIC },
      );
      expect(unauthenticated.status).toBe(401);

      const missingParams = await fetch(
        `http://127.0.0.1:${port}/api/attachments`,
        { method: 'POST', headers },
      );
      expect(missingParams.status).toBe(400);

      const badType = await fetch(
        `http://127.0.0.1:${port}/api/attachments?sessionId=s&name=virus.exe`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          body: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
        },
      );
      expect(badType.status).toBe(415);

      const legacyOversizedBytes = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
        Buffer.alloc(10 * 1024 * 1024, 0xff),
      ]);
      const largeUpload = await fetch(
        `http://127.0.0.1:${port}/api/attachments?sessionId=s&name=large.jpg`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          body: legacyOversizedBytes,
        },
      );
      expect(largeUpload.status).toBe(201);
      await expect(largeUpload.json()).resolves.toMatchObject({
        kind: 'image',
        mime: 'image/jpeg',
        size: legacyOversizedBytes.byteLength,
      });

      const listed = await store.listAttachments('sess_web_abc');
      expect(listed).toHaveLength(1);
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not misclassify unexpected attachment storage failures as media errors', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, {
      attachmentStore: {
        saveAttachment: async () => {
          throw new Error('unused');
        },
        saveAttachmentStream: async () => {
          throw new Error('image storage filesystem unavailable');
        },
        readAttachment: async () => null,
      },
    });
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/attachments?sessionId=s&name=photo.jpg`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer manual-token',
            'content-type': 'application/octet-stream',
          },
          body: Buffer.from([0xff, 0xd8, 0xff]),
        },
      );
      expect(response.status).toBe(500);
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
    const traceListeners = new Set<
      (event: Parameters<Parameters<ManagementWebSessionRuntime['subscribe']>[1]>[0]) => void
    >();
    const sessionRuntime = createSessionRuntime({
      getClientState: () => ({
        activeWorkspaceId: 'workspace_repo',
        activeSessionId: 'sess_web_trace',
      }),
      getReplayEvents: () => [{
        type: 'trace_delta',
        turnId: 'turn-trace',
        fromSequence: 1,
        events: [firstEvent],
      }],
      subscribe(_clientId, listener) {
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

  it('binds an automatic launch context to one session cookie and consumes its token once', async () => {
    const port = await reservePort();
    const launchContexts = new WebLaunchContextService({
      generateToken: () => 'bootstrap-token',
    });
    const launch = launchContexts.issue({
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    });
    const server = createManagementServer(port, { launchContexts });
    await server.start();

    try {
      const first = await exchangeTokenResponse(port, launch.token);
      expect(first.status).toBe(200);
      expect(first.headers.get('set-cookie')).toContain(
        'anyfusion_web_session=session-token-1; HttpOnly; SameSite=Strict; Path=/',
      );
      await expect(first.json()).resolves.toEqual({
        authenticated: true,
        launchContext: {
          workspaceHint: '/repo-a',
          conversationId: 'conv_1',
        },
      });
      const reused = await exchangeTokenResponse(port, launch.token);
      expect(reused.status).toBe(401);

      const cookie = first.headers.get('set-cookie')!.split(';', 1)[0]!;
      const authSession = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
        headers: { cookie },
      });
      expect(authSession.status).toBe(200);
      await expect(authSession.json()).resolves.toEqual({
        authenticated: true,
        launchContext: {
          workspaceHint: '/repo-a',
          conversationId: 'conv_1',
        },
      });
      const config = await fetch(`http://127.0.0.1:${port}/api/config`, {
        headers: { cookie },
      });
      expect(config.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('isolates launch contexts between browser sessions', async () => {
    const port = await reservePort();
    const tokens = ['launch-a', 'launch-b'];
    const launchContexts = new WebLaunchContextService({
      generateToken: () => tokens.shift()!,
    });
    const firstLaunch = launchContexts.issue({ workspaceHint: '/repo-a' });
    const secondLaunch = launchContexts.issue({
      workspaceHint: '/repo-b',
      conversationId: 'conv_b',
    });
    const server = createManagementServer(port, { launchContexts });
    await server.start();

    try {
      const firstCookie = await exchangeToken(port, firstLaunch.token);
      const secondCookie = await exchangeToken(port, secondLaunch.token);
      const [first, second] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/auth/session`, {
          headers: { cookie: firstCookie },
        }),
        fetch(`http://127.0.0.1:${port}/api/auth/session`, {
          headers: { cookie: secondCookie },
        }),
      ]);

      await expect(first.json()).resolves.toMatchObject({
        launchContext: { workspaceHint: '/repo-a' },
      });
      await expect(second.json()).resolves.toMatchObject({
        launchContext: {
          workspaceHint: '/repo-b',
          conversationId: 'conv_b',
        },
      });
    } finally {
      await server.stop();
    }
  });

  it('uses the authenticated browser launch hint only for initial and newly created Conversations', async () => {
    const port = await reservePort();
    const launchContexts = new WebLaunchContextService({
      generateToken: () => 'launch-browser',
    });
    const launch = launchContexts.issue({ workspaceHint: '/repo-browser' });
    const initializations: Array<{ workspaceHint: string; conversationId?: string }> = [];
    const initializationClientIds: string[] = [];
    const createdClientIds: string[] = [];
    const createdRecord = {
      version: 1 as const,
      session: {
        ...metadataFixture('session_new', true),
        workspace: null,
      },
      turns: [],
    };
    const sessionRuntime = createSessionRuntime({
      initializeClient: async (clientId, context) => {
        initializationClientIds.push(clientId);
        if (context) initializations.push(context);
        return { status: 'accepted' };
      },
      createSession: async clientId => {
        createdClientIds.push(clientId);
        return {
          session: createdRecord,
          activation: { state: 'active', sessionId: 'session_new' },
          workspaceInitialization: { status: 'accepted' },
        };
      },
    });
    const server = createManagementServer(port, {
      launchContexts,
      sessionRuntime,
    });
    await server.start();

    try {
      const cookie = await exchangeToken(port, launch.token);
      expect(initializations).toEqual([{ workspaceHint: '/repo-browser' }]);
      expect(initializationClientIds).toEqual(['session-token-1']);

      const created = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/workspace_repo/conversations`,
        {
          method: 'POST',
          headers: {
            cookie,
            'content-type': 'application/json',
          },
        },
      );
      expect(created.status).toBe(201);
      expect(createdClientIds).toEqual(['session-token-1']);
    } finally {
      await server.stop();
    }
  });

  it('does not expose an HTTP endpoint that registers a launch Workspace', async () => {
    const port = await reservePort();
    const server = createManagementServer(port);
    await server.start();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/web-launch/register`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer manual-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ workspaceHint: '/repo-private' }),
      });
      expect(response.status).toBe(404);
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

  it('returns invalid configuration activation as a client-repairable error', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, {
      configQuery: {
        activate: async () => ({
          ok: false,
          code: 'invalid_configuration',
          activeRevisionId: 'revision-test',
          issues: ['agentClasses.planner.modelPolicy.modelRef: no available Model'],
        }),
      },
    });
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/config/activate`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer manual-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            baseRevisionId: 'revision-test',
            config: { schemaVersion: 2 },
          }),
        },
      );

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        code: 'invalid_configuration',
        issues: ['agentClasses.planner.modelPolicy.modelRef: no available Model'],
      });
    } finally {
      await server.stop();
    }
  });

  it('returns activation failures as JSON when the configuration query throws', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, {
      configQuery: {
        activate: async () => {
          throw new Error('planner binding refresh failed');
        },
      },
    });
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/config/activate`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer manual-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            baseRevisionId: 'revision-test',
            config: { schemaVersion: 2 },
          }),
        },
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        code: 'activation_failed',
        issues: ['planner binding refresh failed'],
      });
    } finally {
      await server.stop();
    }
  });

  it('serves configuration completion as a separate catalog projection', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, {
      configQuery: {
        getCompletion: async () => ({
          providers: {
            kimi: {
              baseUrl: 'https://api.kimi.com/coding/v1',
              credentialState: '已从本机 Agent 导入',
              modelIds: ['k3'],
            },
          },
          models: {
            kimi_k3: {
              providerRef: 'kimi',
              modelId: 'k3',
              capabilities: ['planning', 'structured-output'],
              capabilityState: '已从 Provider 补全',
            },
          },
          requiredFields: [],
        }),
      },
    });
    await server.start();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/config/completion`, {
        headers: { authorization: 'Bearer manual-token' },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        providers: {
          kimi: { credentialState: '已从本机 Agent 导入' },
        },
        models: {
          kimi_k3: { capabilityState: '已从 Provider 补全' },
        },
        requiredFields: [],
      });
    } finally {
      await server.stop();
    }
  });

  it('serves an Executor capability manual preview from the configuration query', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, {
      configQuery: {
        getExecutorCapabilityManual: async (agentClassRef, revisionId) => ({
          agentClassRef,
          configurationRevision: revisionId ?? 'revision-test',
          sourceFingerprint: 'sha256:manual',
          markdown: '# Executor: engineering\n\n## Best Fit\n- TypeScript refactoring',
          tags: { bestFit: ['TypeScript refactoring'], avoid: [] },
        }),
      },
    });
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/config/executors/engineering/capability-manual`,
        { headers: { authorization: 'Bearer manual-token' } },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        agentClassRef: 'engineering',
        configurationRevision: 'revision-test',
        sourceFingerprint: 'sha256:manual',
        markdown: '# Executor: engineering\n\n## Best Fit\n- TypeScript refactoring',
        tags: { bestFit: ['TypeScript refactoring'], avoid: [] },
      });
    } finally {
      await server.stop();
    }
  });

  it('analyzes Executor guidance through the configuration query', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, {
      configQuery: {
        analyzeExecutorManual: async (agentClassRef, input) => ({
          agentClassRef,
          configurationRevision: input.baseRevisionId,
          sourceText: input.sourceText,
          analysisMode: 'semantic',
          userProfile: {
            sourceText: input.sourceText,
            assertions: [{ topic: 'preferred-task', text: 'TypeScript refactoring' }],
          },
          manual: {
            agentClassRef,
            configurationRevision: input.baseRevisionId,
            sourceFingerprint: 'sha256:manual',
            markdown: '# Executor: engineering',
            tags: { bestFit: ['TypeScript refactoring'], avoid: [] },
          },
          config: { schemaVersion: 2 },
        }),
      },
    });
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/config/executors/engineering/capability-manual/analyze`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer manual-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            baseRevisionId: 'revision-test',
            sourceText: '更适合 TypeScript 重构。',
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        agentClassRef: 'engineering',
        configurationRevision: 'revision-test',
        analysisMode: 'semantic',
        manual: { markdown: '# Executor: engineering' },
        config: { schemaVersion: 2 },
      });
    } finally {
      await server.stop();
    }
  });

  it('compiles an Executor capability profile through the unified endpoint', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, {
      configQuery: {
        compileExecutorManual: async (agentClassRef, input) => ({
          agentClassRef,
          configurationRevision: input.baseRevisionId,
          sourceText: input.sourceText,
          analysisMode: 'semantic',
          userProfile: {
            sourceText: input.sourceText,
            assertions: [{ topic: 'preferred-task', text: 'TypeScript 重构' }],
          },
          manual: {
            agentClassRef,
            configurationRevision: input.baseRevisionId,
            sourceFingerprint: 'sha256:manual',
            routableCapabilities: ['workspace-engineering'],
            capabilities: [],
            markdown: '# Executor: engineering',
            tags: { bestFit: ['TypeScript 重构'], avoid: [] },
          },
          config: { schemaVersion: 2 },
        }),
      },
    });
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/config/executors/engineering/capability-manual/compile`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer manual-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            baseRevisionId: 'revision-test',
            sourceText: '更适合 TypeScript 重构。',
            config: { schemaVersion: 2 },
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        agentClassRef: 'engineering',
        configurationRevision: 'revision-test',
        analysisMode: 'semantic',
        manual: { markdown: '# Executor: engineering' },
      });
    } finally {
      await server.stop();
    }
  });

  it('accepts empty Executor guidance so the trusted path can clear it', async () => {
    const port = await reservePort();
    let receivedSourceText: string | undefined;
    const server = createManagementServer(port, {
      configQuery: {
        analyzeExecutorManual: async (agentClassRef, input) => {
          receivedSourceText = input.sourceText;
          return {
            agentClassRef,
            configurationRevision: input.baseRevisionId,
            sourceText: input.sourceText,
            analysisMode: 'semantic',
            userProfile: {
              sourceText: '',
              assertionsSourceFingerprint:
                'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              semanticReceipt: 'manual_00000000-0000-4000-8000-000000000000',
              assertions: [],
            },
            manual: {
              agentClassRef,
              configurationRevision: input.baseRevisionId,
              sourceFingerprint: 'sha256:manual',
              markdown: '# Executor: engineering',
              tags: { bestFit: [], avoid: [] },
            },
            config: { schemaVersion: 2 },
          };
        },
      },
    });
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/config/executors/engineering/capability-manual/analyze`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer manual-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            baseRevisionId: 'revision-test',
            sourceText: '',
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(receivedSourceText).toBe('');
      await expect(response.json()).resolves.toMatchObject({
        analysisMode: 'semantic',
        userProfile: {
          sourceText: '',
          assertions: [],
          semanticReceipt: expect.stringMatching(/^manual_/u),
        },
      });
    } finally {
      await server.stop();
    }
  });

  it('previews an Executor manual from the unsaved configuration candidate', async () => {
    const port = await reservePort();
    let receivedConfig: unknown;
    const server = createManagementServer(port, {
      configQuery: {
        previewExecutorCapabilityManual: async (agentClassRef, input) => {
          receivedConfig = input.config;
          return {
            agentClassRef,
            configurationRevision: 'draft-preview',
            sourceFingerprint: 'sha256:preview',
            markdown: '# Executor：engineering\n\n## 适合任务\n- 代码仓库实现',
            tags: { bestFit: ['代码仓库实现'], avoid: [] },
          };
        },
      },
    });
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/config/executors/engineering/capability-manual/preview`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer manual-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            baseRevisionId: 'revision-test',
            config: {
              schemaVersion: 2,
              agentClasses: {
                engineering: {
                  modelPolicy: { mode: 'fixed', modelRef: 'chat-model' },
                },
              },
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        configurationRevision: 'draft-preview',
        tags: { bestFit: ['代码仓库实现'] },
      });
      expect(receivedConfig).toMatchObject({
        agentClasses: {
          engineering: {
            modelPolicy: { mode: 'fixed', modelRef: 'chat-model' },
          },
        },
      });
    } finally {
      await server.stop();
    }
  });

  it('returns source-preserved Executor guidance as a successful analysis result', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, {
      configQuery: {
        analyzeExecutorManual: async (agentClassRef, input) => ({
          agentClassRef,
          configurationRevision: input.baseRevisionId,
          sourceText: input.sourceText,
          analysisMode: 'source-preserved',
          warning: 'Semantic enhancement unavailable; preserved the user guidance.',
          userProfile: {
            sourceText: input.sourceText,
            assertions: [],
          },
          manual: {
            agentClassRef,
            configurationRevision: input.baseRevisionId,
            sourceFingerprint: 'sha256:manual',
            markdown: '# Executor: engineering\n\nAdditional user routing context: code work',
            tags: { bestFit: ['implementation'], avoid: [] },
          },
          config: { schemaVersion: 2 },
        }),
      },
    });
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/config/executors/engineering/capability-manual/analyze`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer manual-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            baseRevisionId: 'revision-test',
            sourceText: 'code work',
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        analysisMode: 'source-preserved',
        warning: expect.stringContaining('preserved'),
        userProfile: { sourceText: 'code work', assertions: [] },
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
    const listeners = new Set<
      (event: Parameters<Parameters<ManagementWebSessionRuntime['subscribe']>[1]>[0]) => void
    >();
    const replay = [{ type: 'output', from: 0, lines: ['第一行', '第二行'] }] as const;
    const sessionRuntime = createSessionRuntime({
      getReplayEvents: () => structuredClone(replay),
      subscribe(_clientId, listener) {
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

  it('serves the read-only Work Graph presentation projection separately from execution commands', async () => {
    const port = await reservePort();
    const projection = {
      configurationRevision: 'revision-1',
      generationId: 'generation-1',
      nodes: [],
      edges: [],
      parallelGroups: [],
      currentRunnableFrontier: [],
    };
    const server = createManagementServer(port, {
      executionQuery: {
        listTasks: () => [],
        projectTimeline: () => null,
        projectWorkGraph: taskId => taskId === 'task-graph' ? projection : null,
      },
    });
    await server.start();
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/execution/tasks/task-graph/work-graph`,
        { headers: { authorization: 'Bearer manual-token' } },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(projection);
      const missing = await fetch(
        `http://127.0.0.1:${port}/api/execution/tasks/missing/work-graph`,
        { headers: { authorization: 'Bearer manual-token' } },
      );
      expect(missing.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
  it('serves same-origin artifact metadata, preview, and download by artifact id only', async () => {
    const port = await reservePort();
    const artifact = {
      artifactId: 'artifact_demo',
      taskId: 'task_ab12cd34',
      publicationId: 'publication_1',
      displayName: 'report.md',
      relativePath: 'report.md',
      mediaType: 'text/markdown; charset=utf-8',
      previewKind: 'markdown' as const,
      previewable: true,
      byteLength: 14,
      contentHash: 'sha256:demo',
      publishedAt: '2026-08-24T01:00:00.000Z',
    };
    const server = createManagementServer(port, {
      artifactQuery: {
        getMetadata: async artifactId => artifactId === 'artifact_demo'
          ? { ok: true as const, artifact }
          : { ok: false as const, reason: 'not_found' as const },
        readPreview: async artifactId => artifactId === 'artifact_demo'
          ? { ok: true as const, artifact, content: '# Demo Report' }
          : { ok: false as const, reason: 'not_found' as const },
        resolveDownload: async () => ({ ok: false as const, reason: 'unavailable' as const }),
      },
    });
    await server.start();
    try {
      const authHeaders = { authorization: 'Bearer manual-token' };
      const unauthorized = await fetch(
        `http://127.0.0.1:${port}/api/artifacts/artifact_demo`,
      );
      expect(unauthorized.status).toBe(401);

      const metadata = await fetch(
        `http://127.0.0.1:${port}/api/artifacts/${encodeURIComponent('artifact_demo')}`,
        { headers: authHeaders },
      );
      expect(metadata.status).toBe(200);
      await expect(metadata.json()).resolves.toEqual({ artifact });

      const preview = await fetch(
        `http://127.0.0.1:${port}/api/artifacts/artifact_demo/preview`,
        { headers: authHeaders },
      );
      expect(preview.status).toBe(200);
      await expect(preview.json()).resolves.toEqual({
        artifact,
        content: '# Demo Report',
      });

      const missing = await fetch(
        `http://127.0.0.1:${port}/api/artifacts/artifact_other/preview`,
        { headers: authHeaders },
      );
      expect(missing.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

interface ManagementServerTestOverrides {
  readonly webSocketAuthTimeoutMs?: number;
  readonly sessionRuntime?: ManagementWebSessionRuntime;
  readonly executionQuery?: { listTasks(): unknown[]; projectTimeline(taskId: string): unknown };
  readonly configQuery?: Partial<ConfigQuery>;
  readonly loginCredentials?: LoginCredentials;
  readonly attachmentStore?: FileAttachmentStore;
  readonly artifactQuery?: import('../../src/management/artifact-preview-service.js').ArtifactPreviewService;
  readonly launchContexts?: WebLaunchContextService;
}

function createManagementServer(
  port: number,
  overrides: ManagementServerTestOverrides = {},
): ManagementServer {
  let sessionCounter = 0;
  const webAuth = new WebAuthService({
    manualAccessToken: 'manual-token',
    launchContexts: overrides.launchContexts ?? new WebLaunchContextService(),
    createSessionToken: () => `session-token-${sessionCounter += 1}`,
  });
  return new ManagementServer({
    port,
    webDistDir: '/tmp/anyfusion-missing-web-dist',
    token: webAuth.manualAccessToken,
    webAuth,
    runningRevisionId: 'revision-runtime',
    webSocketAuthTimeoutMs: overrides.webSocketAuthTimeoutMs,
    sessionRuntime: overrides.sessionRuntime ?? createSessionRuntime(),
    attachmentStore: overrides.attachmentStore,
    artifactQuery: overrides.artifactQuery,
    loginCredentials: 'loginCredentials' in overrides
      ? overrides.loginCredentials
      : resolveLoginCredentials({
        ANYFUSION_WEB_USERNAME: 'admin',
        ANYFUSION_WEB_PASSWORD: 'test-password',
      }),
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
    async initialize() {},
    async initializeClient() { return { status: 'not_requested' }; },
    async closeClient() {},
    async dispose() {},
    getClientState() {
      return { activeWorkspaceId: 'workspace_repo', activeSessionId: 'session_live' };
    },
    async listWorkspaces() { return []; },
    async selectWorkspace() { return { status: 'accepted' }; },
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
    async activateSession(_clientId, sessionId) {
      return { state: 'active', sessionId };
    },
    async deleteSession() {
      return 'not_found';
    },
    async clearAllSessions() {
      return { deleted: 0 };
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
  if (response.status !== 200) throw new Error(`exchange failed with ${response.status}`);
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
