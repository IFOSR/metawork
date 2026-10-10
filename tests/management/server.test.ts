import { LocalAuthorizationService } from '../../src/authorization/local-authorization-service.js';
import { DesktopSessionService } from '../../src/management/desktop-session.js';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createConnection, createServer, type Socket } from 'node:net';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  ManagementServer,
  type ConfigQuery,
  type ManagementWebSessionRuntime,
} from '../../src/management/server.js';
import { WebAuthService } from '../../src/management/web-auth.js';
import { WebLaunchContextService } from '../../src/management/web-launch-context.js';
import {
  WorkspaceDirectoryBrowser,
} from '../../src/management/workspace-directory-browser.js';
import { FileAttachmentStore } from '../../src/storage/file-attachment-store.js';
import {
  resolveLoginCredentials,
  type LoginCredentials,
} from '../../src/management/login-credentials.js';
import type { WebSessionRecordProjection } from '../../src/management/web-session-types.js';
import type { AgentReadiness } from '../../src/management/agent-installation-readiness-service.js';
import { WebGatewayAdmissionError } from '../../src/management/web-gateway-session-runtime.js';
import { ConfigurationActivationBlockedError, ConfigurationActivationGate } from '../../src/configuration/configuration-activation-gate.js';

describe('single settings activation boundary', () => {
  async function request(server: ManagementServer, path: string, body: unknown, authenticated = true) {
    const input = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: 'POST', url: path,
      headers: authenticated ? { authorization: 'Bearer manual-token' } : {},
    }) as IncomingMessage;
    let status = 0;
    let result = '';
    const response = {
      setHeader() {},
      writeHead(value: number) { status = value; },
      end(value: string) { result = value; },
    } as unknown as ServerResponse;
    // Exercise the real HTTP dispatcher without a listener or network socket.
    await server['handleRequest'](input, response);
    return { status, body: JSON.parse(result) };
  }

  it.each(['/api/config/secrets', '/api/config/routing/span/secret', '/api/config/rollback'])(
    'removes standalone mutation through %s', async path => {
      let activations = 0;
      const server = createManagementServer(0, { configQuery: {
        activate: async () => { activations++; return { ok: true, revisionId: 'unexpected' }; },
      } });
      const body = { providerRef: 'provider', apiKey: 'candidate-secret', targetRevisionId: 'old-revision' };
      expect((await request(server, path, body, false)).status).toBe(401);
      expect(await request(server, path, body)).toMatchObject({ status: 404, body: { error: 'not found' } });
      expect(activations).toBe(0);
    },
  );

  it('submits configuration and both credential kinds together exactly once', async () => {
    const calls: unknown[] = [];
    const server = createManagementServer(0, { configQuery: {
      activate: async (...args) => { calls.push(args); return { ok: true, revisionId: 'next-revision' }; },
    } });
    const config = { runtimePolicy: { maxConcurrentTasks: 3 }, agentClasses: { draft: { enabled: true } } };
    const result = await request(server, '/api/config/activate', {
      baseRevisionId: 'revision-test', config, secrets: { provider: 'candidate-secret' }, spanApiKey: ' span-secret ',
    });
    expect(calls).toEqual([['revision-test', config, { provider: 'candidate-secret' }, 'span-secret']]);
    expect(result).toMatchObject({ status: 200, body: { ok: true, revisionId: 'next-revision' } });
    expect(JSON.stringify(result.body)).not.toContain('secret');
  });
});

describe('official account local authentication boundary', () => {
  it('requires local authentication, rejects foreign origins, and never returns an official token', async () => {
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    let logins = 0;
    const fact = { status: 'active' as const, plan: 'internal_perpetual' as const, effectiveAt: new Date().toISOString(), expiresAt: null, revision: 1, serverTime: new Date().toISOString() };
    const auth = new LocalAuthorizationService({ client: {
      login: async () => { logins++; return { sessionToken: 'private-official-session', account: { accountId: 'a', email: 'a@example.com' }, entitlement: fact }; },
      logout: async () => {}, register: async () => {}, verifyEntitlement: async () => fact,
      getPlans: async () => ({ plans: [] }), createOrder: async () => ({}),
      ai: async () => ({ operation: 'model_summary' as const, result: {}, entitlement: fact }),
    } });
    const server = createManagementServer(port, { officialAuthorization: auth });
    await server.start();
    try {
      expect((await fetch(`${origin}/api/official-auth/status`)).status).toBe(401);
      const body = JSON.stringify({ email: 'a@example.com', password: 'private-password' });
      expect((await fetch(`${origin}/api/official-auth/login`, { method: 'POST', body })).status).toBe(401);
      const headers = { authorization: 'Bearer manual-token', 'content-type': 'application/json', origin: 'https://untrusted.example' };
      expect((await fetch(`${origin}/api/official-auth/login`, { method: 'POST', headers, body })).status).toBe(403);
      expect(logins).toBe(0);
      const result = await fetch(`${origin}/api/official-auth/login`, { method: 'POST', headers: { ...headers, origin }, body });
      expect(result.status).toBe(200);
      const projection = await result.text();
      expect(projection).toContain('active'); expect(projection).not.toContain('private-official-session'); expect(projection).not.toContain('private-password');
    } finally { await server.stop(); await auth.dispose(); }
  });
});

describe('executor management API', () => {
  it('exchanges local Desktop tickets only once at the exact HTTP origin', async () => {
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const desktopSessions = new DesktopSessionService(() => ({
      installationId: 'a'.repeat(64), instanceId: 'desktop-instance', accountId: 'local-default',
      releaseId: 'test', pid: process.pid, webOrigin: origin, gatewayProtocolVersion: 2,
    }));
    const server = createManagementServer(port, { desktopSessions });
    await server.start();
    try {
      const grant = desktopSessions.issue('b'.repeat(64), 'local-default');
      const body = JSON.stringify({ ticket: grant.ticket, nonce: grant.nonce, instanceId: grant.instanceId });
      const path = `${origin}/api/auth/desktop-session`;
      expect((await fetch(path, { method: 'POST', body })).status).toBe(403);
      expect((await fetch(path, { method: 'POST', body, headers: { Origin: 'http://evil.example' } })).status).toBe(403);
      const response = await fetch(path, { method: 'POST', body, headers: { Origin: origin } });
      expect(response.status).toBe(200);
      const cookie = response.headers.get('set-cookie')!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(await response.json()).toEqual({ authenticated: true, accountId: 'local-default', instanceId: 'desktop-instance' });
      expect((await fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie.split(';')[0]! } })).status).toBe(200);
      expect((await fetch(path, { method: 'POST', body, headers: { Origin: origin } })).status).toBe(401);
      const hint = await fetch(`${origin}/api/auth/launch-context`, {
        method: 'POST', body: JSON.stringify({ token: grant.ticket }), headers: { Origin: origin },
      });
      expect(hint.status).toBe(404);
      const proof = await fetch(`${origin}/api/auth/desktop-instance?nonce=${grant.nonce}`);
      expect(await proof.json()).toEqual({ proof: grant.proof });
      expect(proof.headers.get('cache-control')).toBe('no-store');
    } finally { await server.stop(); }
  });

  it('authenticates and validates the read-only Agent capability description request', async () => {
    const port = await reservePort();
    const calls: unknown[] = [];
    const server = createManagementServer(port, { configQuery: {
      describeAgentCapabilities: async (input, refresh) => {
        calls.push({ input, refresh });
        return { summary: '该智能体可分析代码。', abilities: [{ title: '代码分析', description: '定位修改范围。' }], boundaries: [] };
      },
    } });
    await server.start();
    try {
      const url = `http://127.0.0.1:${port}/api/config/agent-capabilities`;
      expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
      const headers = { authorization: 'Bearer manual-token', 'content-type': 'application/json' };
      expect((await fetch(url, { method: 'POST', headers, body: '{}' })).status).toBe(400);
      const input = { kind: 'executor', affordances: [], models: [{ modelRef: 'm1', modelId: 'example', capabilities: ['coding'] }] };
      const result = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...input, refresh: true, apiKey: 'must-not-forward' }) });
      expect(result.status).toBe(200);
      expect(calls).toEqual([{ input, refresh: true }]);
    } finally { await server.stop(); }
  });

  it('summarizes only the authenticated selected catalog model, ignoring client-supplied facts', async () => {
    const port = await reservePort();
    const calls: string[] = [];
    const server = createManagementServer(port, { configQuery: {
      summarizeModelInformation: async catalogModelId => {
        calls.push(catalogModelId);
        return { catalogModelId, routingNotes: { summary: '代码实现', preferredTaskTypes: ['回归测试'] } };
      },
    } });
    await server.start();
    try {
      const url = `http://127.0.0.1:${port}/api/config/model-routing-profile`;
      expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
      const headers = { authorization: 'Bearer manual-token', 'content-type': 'application/json' };
      expect((await fetch(url, { method: 'POST', headers, body: '{}' })).status).toBe(400);
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({
        catalogModelId: 'openai/gpt-6-sol', description: 'untrusted override', baseUrl: 'https://untrusted.example',
      }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ routingNotes: { preferredTaskTypes: ['回归测试'] } });
      expect(calls).toEqual(['openai/gpt-6-sol']);
    } finally { await server.stop(); }
  });

  it('serves read-only billing records and task detail through the session runtime', async () => {
    const port = await reservePort();
    const listCalls: Array<Record<string, unknown>> = [];
    const detailCalls: string[] = [];
    const bill = {
      billId: 'bill_1',
      queryId: 'query_1',
      taskId: 'task_1',
      turnId: 'turn_1',
      conversationId: 'conv_1',
      createdAt: '2026-09-22T00:00:00.000Z',
      state: 'finalized',
      userStatus: 'billed',
      assessedMicroCoin: '28',
      assessedIsFinal: true,
      externalState: 'not_exported',
      externalEntryId: null,
      confirmedDeductedMicroCoin: null,
      coverage: 'complete',
      coverageNote: null,
      platformAbsorption: null,
      payerSummary: [],
      lines: [],
      adjustments: [],
      finalizedAt: '2026-09-22T00:01:00.000Z',
      diagnosticCode: null,
      diagnosticMessage: null,
      observedUsageCount: 2,
      missingCategories: [],
    };
    const sessionRuntime = createSessionRuntime({
      listBillingTasks: async () => [{
        taskId: 'task_without_query',
        taskTitle: '历史无计量任务',
        queryCount: 0,
      }],
      listBillingRecords: async (_clientId, input = {}) => {
        listCalls.push({ ...input });
        return {
          items: [{ bill, requestSummary: '调研请求', taskTitle: '调研任务' }],
          nextCursor: null,
        };
      },
      getTaskBillingDetail: async (_clientId, taskId) => {
        detailCalls.push(taskId);
        return {
          taskId,
          taskTitle: '调研任务',
          items: [{ bill, requestSummary: '调研请求', taskTitle: '调研任务' }],
        };
      },
    });
    const server = createManagementServer(port, { sessionRuntime });
    await server.start();
    try {
      const headers = { authorization: 'Bearer manual-token' };
      // 未认证请求 fail closed。
      const denied = await fetch(`http://127.0.0.1:${port}/api/billing/records`);
      expect(denied.status).toBe(401);

      const records = await fetch(
        `http://127.0.0.1:${port}/api/billing/records?filter=billed&limit=5`,
        { headers },
      );
      expect(records.status).toBe(200);
      expect(await records.json()).toEqual({
        items: [{ bill, requestSummary: '调研请求', taskTitle: '调研任务' }],
        nextCursor: null,
      });
      expect(listCalls[0]).toEqual({ filter: 'billed', limit: 5 });

      const invalidFilter = await fetch(
        `http://127.0.0.1:${port}/api/billing/records?filter=hacker`,
        { headers },
      );
      expect(invalidFilter.status).toBe(200);
      expect(listCalls[1]).toEqual({ filter: 'all' });

      const detail = await fetch(`http://127.0.0.1:${port}/api/billing/tasks/task_1`, {
        headers,
      });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ taskId: 'task_1' });
      expect(detailCalls).toEqual(['task_1']);

      const tasks = await fetch(`http://127.0.0.1:${port}/api/billing/tasks`, { headers });
      expect(tasks.status).toBe(200);
      expect(await tasks.json()).toEqual([{
        taskId: 'task_without_query',
        taskTitle: '历史无计量任务',
        queryCount: 0,
      }]);
    } finally {
      await server.stop();
    }
  });

  it('exposes authenticated prepare without activating a candidate', async () => {
    const port = await reservePort();
    const calls: unknown[] = [];
    const server = createManagementServer(port, {
      configQuery: {
        prepareExecutor: async input => {
          calls.push(input);
          return { baseRevisionId: 'revision-test', config: {}, summary: ['新增助手'], createdAgentClassRef: 'executor-new' };
        },
      },
    });
    await server.start();
    try {
      const url = `http://127.0.0.1:${port}/api/config/executors/prepare`;
      expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
      const response = await fetch(url, {
        method: 'POST', headers: { authorization: 'Bearer manual-token', 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevisionId: 'revision-test', change: { operation: 'remove', agentClassRef: 'x' }, config: { draft: true } }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ createdAgentClassRef: 'executor-new' });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ baseRevisionId: 'revision-test', change: { operation: 'remove', agentClassRef: 'x' }, config: { draft: true } });
    } finally { await server.stop(); }
  });

  it('returns a structured busy response for activation and legacy manual compilation', async () => {
    const port = await reservePort();
    const gate = new ConfigurationActivationGate(() => ({
      activeTaskId: 'task-1', plannerTurnActive: false, activeAttemptCount: 0,
      activeLeaseCount: 0, publicationPending: false, recoveryInProgress: false,
    }));
    const blocked = async (): Promise<never> => { throw new ConfigurationActivationBlockedError(gate.getStatus()); };
    const server = createManagementServer(port, { configQuery: { activate: blocked, compileExecutorManual: blocked } });
    await server.start();
    try {
      for (const [path, body] of [
        ['/api/config/activate', { baseRevisionId: 'revision-test', config: {} }],
        ['/api/config/executors/x/capability-manual/compile', { baseRevisionId: 'revision-test', sourceText: '' }],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST', headers: { authorization: 'Bearer manual-token', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'runtime_busy' });
      }
    } finally { await server.stop(); }
  });
});

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
        capabilities: [],
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
        nextCursor: null,
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
      expect(ok.status).toBe(200);
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
    const server = createManagementServer(port, {
      attachmentStore: store,
      sessionRuntime: createSessionRuntime({
        getClientState: () => ({
          activeWorkspaceId: 'workspace_repo',
          activeSessionId: 'sess_web_abc',
        }),
      }),
    });
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
        conversationId: string;
        workspaceId: string;
      };
      expect(meta.kind).toBe('image');
      expect(meta.mime).toBe('image/png');
      expect(meta.conversationId).toBe('sess_web_abc');
      expect(meta.workspaceId).toBe('workspace_repo');

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
        `http://127.0.0.1:${port}/api/attachments?sessionId=sess_web_abc&name=virus.exe`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          body: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
        },
      );
      expect(badType.status).toBe(201);
      await expect(badType.json()).resolves.toMatchObject({
        kind: 'file',
        mediaClass: 'unknown',
        mime: 'application/octet-stream',
        name: 'virus.exe',
      });

      const legacyOversizedBytes = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
        Buffer.alloc(10 * 1024 * 1024, 0xff),
      ]);
      const largeUpload = await fetch(
        `http://127.0.0.1:${port}/api/attachments?sessionId=sess_web_abc&name=large.jpg`,
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
      expect(listed).toHaveLength(3);
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not misclassify unexpected attachment storage failures as media errors', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, {
      sessionRuntime: createSessionRuntime({
        getClientState: () => ({
          activeWorkspaceId: 'workspace_repo',
          activeSessionId: 's',
        }),
      }),
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

  it('serves a launch Workspace hint without authenticating the caller', async () => {
    const port = await reservePort();
    const launchContexts = new WebLaunchContextService({
      generateToken: () => 'launch-token',
    });
    const launch = launchContexts.issue({
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    });
    const server = createManagementServer(port, { launchContexts });
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/auth/launch-context`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: `http://127.0.0.1:${port}`,
          },
          body: JSON.stringify({ token: launch.token }),
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        workspaceHint: '/repo-a',
        conversationId: 'conv_1',
      });
      // 提示端点不得下发会话 cookie。
      expect(response.headers.get('set-cookie')).toBeNull();
      // 一次性消费。
      const reused = await fetch(
        `http://127.0.0.1:${port}/api/auth/launch-context`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: `http://127.0.0.1:${port}`,
          },
          body: JSON.stringify({ token: launch.token }),
        },
      );
      expect(reused.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it('rejects launch hint requests from a foreign browser origin', async () => {
    const port = await reservePort();
    const server = createManagementServer(port);
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/auth/launch-context`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://attacker.example',
          },
          body: JSON.stringify({ token: 'whatever' }),
        },
      );
      expect(response.status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  it('does not apply a launch hint during login', async () => {
    const port = await reservePort();
    const launchContexts = new WebLaunchContextService({
      generateToken: () => 'launch-browser',
    });
    const launch = launchContexts.issue({ workspaceHint: '/repo-browser' });
    const server = createManagementServer(port, { launchContexts });
    await server.start();

    try {
      const bootstrap = await fetch(`http://127.0.0.1:${port}/api/auth/bootstrap`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ token: launch.token }),
      });
      // 启动提示 token 不再能换取会话。
      expect(bootstrap.status).toBe(401);

      const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ username: 'admin', password: 'test-password' }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]!;
      const session = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
        headers: { cookie },
      });
      await expect(session.json()).resolves.toEqual({ authenticated: true });
    } finally {
      await server.stop();
    }
  });

  it('browses directories for cookie sessions only', async () => {
    const port = await reservePort();
    const root = await mkdtemp(join(tmpdir(), 'browse-endpoint-'));
    await mkdir(join(root, 'repo'));
    const browser = new WorkspaceDirectoryBrowser({ defaultPath: () => root });
    const server = createManagementServer(port, { workspaceDirectoryBrowser: browser });
    await server.start();

    try {
      // Bearer token 共享 clientId，无法界定“谁在浏览服务器目录”。
      const bearer = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/browse`,
        { headers: { authorization: 'Bearer manual-token' } },
      );
      expect(bearer.status).toBe(403);

      const cookie = await exchangeToken(port, 'manual-token');
      const response = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/browse`,
        { headers: { cookie } },
      );
      expect(response.status).toBe(200);
      const payload = await response.json() as {
        path: string;
        parent: string | null;
        crumbs: Array<{ name: string; path: string }>;
        entries: Array<{ name: string }>;
      };
      expect(payload.path).toBe(await realpath(root));
      expect(payload.entries.map(entry => entry.name)).toEqual(['repo']);
      // Server 必须提供结构化路径段，客户端不解析操作系统路径。
      expect(payload.crumbs.at(-1)).toEqual({
        name: basename(payload.path),
        path: payload.path,
      });
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps browse failures onto HTTP status codes', async () => {
    const port = await reservePort();
    const root = await mkdtemp(join(tmpdir(), 'browse-errors-'));
    const server = createManagementServer(port, {
      workspaceDirectoryBrowser: new WorkspaceDirectoryBrowser({ defaultPath: () => root }),
    });
    await server.start();

    try {
      const cookie = await exchangeToken(port, 'manual-token');
      const browse = (path: string) => fetch(
        `http://127.0.0.1:${port}/api/workspaces/browse?path=${encodeURIComponent(path)}`,
        { headers: { cookie } },
      );

      expect((await browse('relative')).status).toBe(400);
      expect((await browse(join(root, 'missing'))).status).toBe(404);
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
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

  it('discovers provider models with the credentials supplied by the settings form', async () => {
    const port = await reservePort();
    const calls: Array<{ baseUrl: string; apiKey?: string; providerRef?: string }> = [];
    const server = createManagementServer(port, {
      configQuery: {
        discoverProviderModels: async input => {
          calls.push(input);
          return {
            status: 'discovered',
            modelIds: ['deepseek-v4-pro'],
            capabilities: { 'deepseek-v4-pro': ['coding', 'structured-output'] },
          };
        },
      },
    });
    await server.start();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/config/discover-models`, {
        method: 'POST',
        headers: { authorization: 'Bearer manual-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-form-key',
          providerRef: 'deepseek',
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status: 'discovered',
        modelIds: ['deepseek-v4-pro'],
        capabilities: { 'deepseek-v4-pro': ['coding', 'structured-output'] },
      });
      expect(calls).toEqual([{
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-form-key',
        providerRef: 'deepseek',
      }]);

      const invalid = await fetch(`http://127.0.0.1:${port}/api/config/discover-models`, {
        method: 'POST',
        headers: { authorization: 'Bearer manual-token', 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'https://api.deepseek.com/v1' }),
      });
      expect(invalid.status).toBe(400);
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

  it('returns masked credential summaries for requested Providers', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, {
      configQuery: {
        getSecretStatus: async () => ({
          openai: { configured: true, maskedApiKey: '••••••••cdef' },
          missing: { configured: false, maskedApiKey: null },
        }),
      },
    });
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/config/secrets/status?providers=openai,missing`,
        {
          headers: { authorization: 'Bearer manual-token' },
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        openai: { configured: true, maskedApiKey: '••••••••cdef' },
        missing: { configured: false, maskedApiKey: null },
      });
    } finally {
      await server.stop();
    }
  });

  it('serves authenticated agent readiness and forces an explicit refresh', async () => {
    const port = await reservePort();
    const agents = [readinessFixture()];
    let refreshCalls = 0;
    const server = createManagementServer(port, {
      agentReadiness: {
        getState: () => agents,
        refresh: async () => {
          refreshCalls += 1;
          return agents;
        },
        subscribe: () => () => undefined,
      },
    });
    await server.start();

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${port}/api/agents/readiness`);
      expect(unauthorized.status).toBe(401);

      const response = await fetch(`http://127.0.0.1:${port}/api/agents/readiness`, {
        headers: { authorization: 'Bearer manual-token' },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ agents });

      const refresh = await fetch(`http://127.0.0.1:${port}/api/agents/readiness/refresh`, {
        method: 'POST',
        headers: { authorization: 'Bearer manual-token' },
      });
      expect(refresh.status).toBe(200);
      expect(refreshCalls).toBeGreaterThanOrEqual(2);
      await expect(refresh.json()).resolves.toEqual({ agents });
    } finally {
      await server.stop();
    }
  });

  it('sends readiness to a new WebSocket and broadcasts state transitions', async () => {
    const port = await reservePort();
    const listeners = new Set<(agents: readonly AgentReadiness[]) => void>();
    const agents = [readinessFixture()];
    const server = createManagementServer(port, {
      agentReadiness: {
        getState: () => agents,
        refresh: async () => agents,
        subscribe: listener => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    await server.start();
    const cookie = await exchangeToken(port, 'manual-token');
    const client = await connectWebSocket(port, `http://127.0.0.1:${port}`, cookie);

    try {
      await expect(client.nextText()).resolves.toContain('"type":"hello"');
      await expect(client.nextText()).resolves.toBe(JSON.stringify({
        type: 'agent_readiness_state',
        agents,
      }));
      for (const listener of listeners) listener([{
        ...agents[0]!,
        status: 'missing',
      }]);
      await expect(client.nextText()).resolves.toContain('"status":"missing"');
    } finally {
      client.close();
      await server.stop();
    }
  });

  it('returns the required-Agent code when HTTP conversation creation is blocked', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, {
      sessionRuntime: createSessionRuntime({
        async createSession() {
          throw new WebGatewayAdmissionError('required_agent_unavailable', 'pi-agent');
        },
      }),
    });
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/workspace_repo/conversations`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer manual-token',
            'content-type': 'application/json',
          },
        },
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: 'required_agent_unavailable',
        agentId: 'pi-agent',
      });
    } finally {
      await server.stop();
    }
  });

  it('keeps the required-Agent details on a WebSocket input rejection', async () => {
    const port = await reservePort();
    const server = createManagementServer(port, {
      sessionRuntime: createSessionRuntime({
        async submit() {
          throw new WebGatewayAdmissionError('required_agent_unavailable', 'pi-agent');
        },
      }),
    });
    await server.start();
    const cookie = await exchangeToken(port, 'manual-token');
    const client = await connectWebSocket(port, `http://127.0.0.1:${port}`, cookie);

    try {
      await client.nextText();
      client.sendJson({ type: 'input', requestId: 'req_blocked', text: '开始工作' });
      await expect(client.nextText()).resolves.toBe(JSON.stringify({
        type: 'error',
        message: 'required_agent_unavailable',
        requestId: 'req_blocked',
        code: 'required_agent_unavailable',
        agentId: 'pi-agent',
      }));
    } finally {
      client.close();
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
        turnId: 'turn-live',
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
        JSON.stringify({
          type: 'execution',
          turnId: 'turn-live',
          taskId: 'task-live',
          timeline,
        }),
      );

      const second = await connectWebSocket(port, `http://127.0.0.1:${port}`, cookie);
      try {
        await expect(second.nextText()).resolves.toContain('"type":"hello"');
        await expect(second.nextText()).resolves.toBe(
          JSON.stringify({
            type: 'execution',
            turnId: 'turn-live',
            taskId: 'task-live',
            timeline,
          }),
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

  it('downloads original Markdown or a derived PDF through the same artifact authorization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-report-download-'));
    const source = '# 中文报告\r\n\r\n完整原文，不应修改。\r\n';
    const path = join(root, 'report.md');
    await writeFile(path, source);
    const artifact = { displayName: '中文报告.md', previewKind: 'markdown', mediaType: 'text/markdown', byteLength: Buffer.byteLength(source) };
    const port = await reservePort();
    const server = createManagementServer(port, { artifactQuery: {
      resolveDownload: async (id: string) => id === 'denied' ? { ok: false, reason: 'unauthorized' }
        : id === 'missing' ? { ok: false, reason: 'not_found' }
        : { ok: true, artifact: id === 'binary' ? { ...artifact, previewKind: 'unsupported' } : artifact, absolutePath: id === 'unavailable' ? join(root, 'missing.md') : path },
      readReportImage: async () => undefined,
    } as never });
    await server.start();
    try {
      const headers = { authorization: 'Bearer manual-token' };
      const url = `http://127.0.0.1:${port}/api/artifacts/report/download`;
      expect((await fetch(`${url}?format=pdf`)).status).toBe(401);
      const original = await fetch(url, { headers });
      expect(await original.text()).toBe(source);
      const pdf = await fetch(`${url}?format=pdf`, { headers });
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get('content-type')).toBe('application/pdf');
      expect(decodeURIComponent(pdf.headers.get('content-disposition')!)).toContain('中文报告.pdf');
      expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
      for (const [id, status] of [['denied', 403], ['missing', 404], ['binary', 415], ['unavailable', 500]] as const) {
        expect((await fetch(url.replace('/report/', `/${id}/`) + '?format=pdf', { headers })).status).toBe(status);
      }
      expect((await fetch(`${url}?format=docx`, { headers })).status).toBe(400);
    } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
  });
});

interface ManagementServerTestOverrides {
  officialAuthorization?: LocalAuthorizationService;
  desktopSessions?: DesktopSessionService;
  readonly webSocketAuthTimeoutMs?: number;
  readonly sessionRuntime?: ManagementWebSessionRuntime;
  readonly executionQuery?: { listTasks(): unknown[]; projectTimeline(taskId: string): unknown };
  readonly configQuery?: Partial<ConfigQuery>;
  readonly loginCredentials?: LoginCredentials;
  readonly attachmentStore?: FileAttachmentStore;
  readonly artifactQuery?: import('../../src/management/artifact-preview-service.js').ArtifactPreviewService;
  readonly launchContexts?: WebLaunchContextService;
  readonly workspaceDirectoryBrowser?: WorkspaceDirectoryBrowser;
  readonly agentReadiness?: {
    getState(): readonly AgentReadiness[];
    refresh(input?: { force?: boolean }): Promise<readonly AgentReadiness[]>;
    subscribe(listener: (agents: readonly AgentReadiness[]) => void): () => void;
  };
}

function createManagementServer(
  port: number,
  overrides: ManagementServerTestOverrides = {},
): ManagementServer {
  let sessionCounter = 0;
  const webAuth = new WebAuthService({
    manualAccessToken: 'manual-token',
    createSessionToken: () => `session-token-${sessionCounter += 1}`,
  });
  return new ManagementServer({
    port,
    webDistDir: '/tmp/anyfusion-missing-web-dist',
    token: webAuth.manualAccessToken,
    webAuth,
    desktopSessions: overrides.desktopSessions,
    officialAuthorization: overrides.officialAuthorization,
    launchContexts: overrides.launchContexts ?? new WebLaunchContextService(),
    workspaceDirectoryBrowser: overrides.workspaceDirectoryBrowser
      ?? new WorkspaceDirectoryBrowser(),
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
      ...overrides.configQuery,
    },
    agentReadiness: overrides.agentReadiness,
  });
}

function readinessFixture(): AgentReadiness {
  return {
    agentId: 'pi-agent',
    required: true,
    displayName: '智能体 1',
    status: 'installed',
    version: 'pi 1.0.0',
    detail: null,
    installUrl: 'https://example.com/pi',
    checkedAt: '2026-09-16T00:00:00.000Z',
  };
}

function createSessionRuntime(
  overrides: Partial<ManagementWebSessionRuntime> = {},
): ManagementWebSessionRuntime {
  return {
    async initialize() {},
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
