import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runBrowserE2e = process.env.RUN_BROWSER_E2E === '1';
const e2e = runBrowserE2e ? describe : describe.skip;

e2e('Workspace Conversation directory browser flow', () => {
  it('shares summaries across browsers and gates detail until attach', async () => {
    const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const webDist = join(root, 'web', 'dist');
    await stat(join(webDist, 'index.html'));
    const server = await startMockServer(webDist);
    const first = await launchBrowser(server.port, 'workspace-directory-a');
    const second = await launchBrowser(server.port, 'workspace-directory-b');

    try {
      await Promise.all([
        waitForExpression(first.cdp, `Boolean(document.querySelector('.workspace-home'))`),
        waitForExpression(second.cdp, `Boolean(document.querySelector('.workspace-home'))`),
      ]);

      await first.cdp.evaluate(`document.querySelector('.new-session-button').click()`);
      await Promise.all([
        waitForExpression(
          first.cdp,
          `document.querySelector('.session-row')?.innerText.includes('Shared workspace task')`,
        ),
        waitForExpression(
          second.cdp,
          `document.querySelector('.session-row')?.innerText.includes('Shared workspace task')`,
        ),
      ]);

      server.setRunning();
      await waitForExpression(
        second.cdp,
        `document.querySelector('.session-row')?.innerText.includes('执行中')`,
      );
      expect(await second.cdp.evaluate(
        `document.body.innerText.includes('DETAIL_RESULT')`,
      )).toBe(false);

      await second.cdp.evaluate(`document.querySelector('.session-row').click()`);
      await waitForExpression(
        second.cdp,
        `Boolean(document.querySelector('.conversation-attach-prompt'))`,
      );
      expect(await second.cdp.evaluate(
        `document.body.innerText.includes('DETAIL_RESULT')`,
      )).toBe(false);
      await second.cdp.evaluate(
        `document.querySelector('.conversation-attach-prompt button').click()`,
      );
      await waitForExpression(
        second.cdp,
        `document.body.innerText.includes('DETAIL_RESULT')`,
      );

      await first.cdp.evaluate(`(() => {
        const select = document.querySelector('#workspace-select');
        select.value = 'workspace-b';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitForExpression(
        first.cdp,
        `document.querySelector('#workspace-select')?.value === 'workspace-b'`,
      );
      expect(await second.cdp.evaluate(
        `document.querySelector('#workspace-select')?.value`,
      )).toBe('workspace-a');

      expect(await first.cdp.evaluate(
        `document.documentElement.scrollWidth <= window.innerWidth`,
      )).toBe(true);
      await second.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(100);
      expect(await second.cdp.evaluate(
        `document.documentElement.scrollWidth <= window.innerWidth`,
      )).toBe(true);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await server.close();
    }
  }, 45_000);
});

async function startMockServer(webDist: string): Promise<{
  port: number;
  setRunning(): void;
  close(): Promise<void>;
}> {
  const sockets = new Map<Socket, string>();
  const clientState = new Map<string, {
    activeWorkspaceId: string;
    activeConversationId: string | null;
  }>();
  let nextClientId = 0;
  let conversationCreated = false;
  let running = false;

  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(String(error));
    });
  });
  server.on('upgrade', (request, socket) => {
    const clientId = cookieValue(request.headers.cookie, 'browser_client');
    const key = request.headers['sec-websocket-key'];
    const headerKey = Array.isArray(key) ? key[0] : key;
    if (!clientId || !headerKey || !clientState.has(clientId)) {
      socket.destroy();
      return;
    }
    const accepted = createHash('sha1')
      .update(`${headerKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accepted}\r\n\r\n`,
    );
    sockets.set(socket as Socket, clientId);
    socket.once('close', () => sockets.delete(socket as Socket));
    send(socket as Socket, {
      type: 'hello',
      sessionId: clientState.get(clientId)?.activeConversationId ?? null,
    });
    socket.on('error', () => socket.destroy());
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/auth/session') {
      let clientId = cookieValue(request.headers.cookie, 'browser_client');
      if (!clientId) {
        clientId = `browser-${nextClientId += 1}`;
        clientState.set(clientId, {
          activeWorkspaceId: 'workspace-a',
          activeConversationId: null,
        });
        response.setHeader('Set-Cookie', `browser_client=${clientId}; Path=/; SameSite=Strict`);
      }
      json(response, { authenticated: true, launchContext: null });
      return;
    }
    if (url.pathname === '/api/ws/diagnostics') {
      json(response, { ok: true });
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      await serveStatic(webDist, url.pathname, response);
      return;
    }

    const clientId = cookieValue(request.headers.cookie, 'browser_client');
    const state = clientId ? clientState.get(clientId) : null;
    if (!clientId || !state) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (url.pathname === '/api/workspaces') {
      json(response, {
        activeWorkspaceId: state.activeWorkspaceId,
        workspaces: WORKSPACES,
      });
      return;
    }
    if (url.pathname === '/api/workspaces/select' && request.method === 'POST') {
      const body = await readJsonBody(request) as { path?: string };
      const workspace = WORKSPACES.find(item => item.canonicalPath === body.path);
      if (!workspace) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: 'workspace_not_found' }));
        return;
      }
      state.activeWorkspaceId = workspace.id;
      json(response, {
        selection: { status: 'accepted' },
        activeWorkspaceId: state.activeWorkspaceId,
        activeSessionId: state.activeConversationId,
      });
      return;
    }
    const workspaceConversations = /^\/api\/workspaces\/([^/]+)\/conversations$/u
      .exec(url.pathname);
    if (workspaceConversations && request.method === 'GET') {
      const workspaceId = decodeURIComponent(workspaceConversations[1]!);
      json(response, {
        activeWorkspaceId: workspaceId,
        activeConversationId: state.activeConversationId,
        conversations: workspaceId === 'workspace-a' && conversationCreated
          ? [conversationSummary(state.activeConversationId === 'conv-shared', running)]
          : [],
      });
      return;
    }
    if (workspaceConversations && request.method === 'POST') {
      conversationCreated = true;
      state.activeWorkspaceId = 'workspace-a';
      state.activeConversationId = 'conv-shared';
      broadcastDirectory();
      json(response, {
        session: conversationRecord(true),
        activation: { state: 'active', sessionId: 'conv-shared' },
        workspaceInitialization: { status: 'not_requested' },
      }, 201);
      return;
    }
    if (url.pathname === '/api/conversations/conv-shared/attach' && request.method === 'POST') {
      state.activeWorkspaceId = 'workspace-a';
      state.activeConversationId = 'conv-shared';
      sendClient(clientId, { type: 'active_session_changed', sessionId: 'conv-shared' });
      json(response, { state: 'active', sessionId: 'conv-shared' });
      return;
    }
    if (url.pathname === '/api/conversations/conv-shared') {
      if (state.activeConversationId !== 'conv-shared') {
        response.writeHead(404);
        response.end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      json(response, conversationRecord(true));
      return;
    }
    if (url.pathname === '/api/config') {
      json(response, {
        revisionId: 'revision-browser-test',
        runningRevisionId: 'revision-browser-test',
        contentHash: 'sha256:browser-test',
        config: {},
      });
      return;
    }
    response.writeHead(404);
    response.end();
  }

  function broadcastDirectory(): void {
    for (const [socket, clientId] of sockets) {
      const state = clientState.get(clientId);
      if (!state || state.activeWorkspaceId !== 'workspace-a') continue;
      send(socket, {
        type: 'workspace_directory',
        activeWorkspaceId: 'workspace-a',
        activeSessionId: state.activeConversationId,
        sessions: conversationCreated
          ? [conversationSummary(state.activeConversationId === 'conv-shared', running)]
          : [],
      });
    }
  }

  function sendClient(clientId: string, message: unknown): void {
    for (const [socket, socketClientId] of sockets) {
      if (socketClientId === clientId) send(socket, message);
    }
  }

  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind');
  return {
    port: address.port,
    setRunning() {
      running = true;
      broadcastDirectory();
    },
    async close() {
      for (const socket of sockets.keys()) socket.destroy();
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    },
  };
}

const WORKSPACES = [
  {
    id: 'workspace-a',
    accountId: 'local-default',
    displayName: 'workspace-a',
    canonicalPath: '/repo/workspace-a',
    availability: 'available',
    createdAt: '2026-08-27T08:00:00.000Z',
    updatedAt: '2026-08-27T08:00:00.000Z',
    createdByPrincipal: 'web:browser-test',
    archived: false,
  },
  {
    id: 'workspace-b',
    accountId: 'local-default',
    displayName: 'workspace-b',
    canonicalPath: '/repo/workspace-b',
    availability: 'available',
    createdAt: '2026-08-27T08:00:00.000Z',
    updatedAt: '2026-08-27T08:00:00.000Z',
    createdByPrincipal: 'web:browser-test',
    archived: false,
  },
] as const;

function conversationSummary(active: boolean, executing: boolean) {
  return {
    id: 'conv-shared',
    workspaceId: 'workspace-a',
    title: 'Shared workspace task',
    createdAt: '2026-08-27T08:00:00.000Z',
    updatedAt: '2026-08-27T08:01:00.000Z',
    active,
    archived: false,
    preview: 'Shared workspace task',
    activity: {
      state: executing ? 'executing' : 'idle',
      taskId: executing ? 'task-shared' : null,
      updatedAt: '2026-08-27T08:01:00.000Z',
    },
    workspace: null,
  };
}

function conversationRecord(active: boolean) {
  return {
    version: 1,
    session: {
      ...conversationSummary(active, false),
      workspace: {
        path: '/repo/workspace-a',
        selectedAt: '2026-08-27T08:00:00.000Z',
      },
    },
    turns: [{
      id: 'turn-shared',
      sessionId: 'conv-shared',
      userInput: 'Shared workspace task',
      status: 'completed',
      finalAnswer: 'DETAIL_RESULT',
      taskId: 'task-shared',
      startedAt: '2026-08-27T08:00:00.000Z',
      completedAt: '2026-08-27T08:01:00.000Z',
      traceEvents: [],
      executionTimeline: null,
      artifactRefs: [],
      artifacts: [],
    }],
  };
}

async function launchBrowser(port: number, prefix: string): Promise<{
  cdp: CdpClient;
  close(): Promise<void>;
}> {
  const profile = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,1000',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/`,
  ], { stdio: 'ignore' });
  const debuggingPort = await waitForDebuggingPort(profile);
  const target = await waitForPageTarget(debuggingPort);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return {
    cdp,
    async close() {
      cdp.close();
      chrome.kill('SIGTERM');
      await waitForExit(chrome);
      await rm(profile, { recursive: true, force: true });
    },
  };
}

async function serveStatic(
  webDist: string,
  pathname: string,
  response: ServerResponse,
): Promise<void> {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/u, '');
  const path = join(webDist, requested);
  try {
    const bytes = await readFile(path);
    response.writeHead(200, { 'Content-Type': mimeType(extname(path)) });
    response.end(bytes);
  } catch {
    const bytes = await readFile(join(webDist, 'index.html'));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(bytes);
  }
}

function mimeType(extension: string): string {
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
  }[extension] ?? 'application/octet-stream';
}

function send(socket: Socket, message: unknown): void {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const entry of header?.split(';') ?? []) {
    const [key, ...parts] = entry.trim().split('=');
    if (key === name) return parts.join('=');
  }
  return null;
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function waitForDebuggingPort(profile: string): Promise<number> {
  const file = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      return Number((await readFile(file, 'utf8')).split('\n')[0]);
    } catch {
      await delay(50);
    }
  }
  throw new Error('Chrome DevTools port was not created');
}

async function waitForPageTarget(port: number): Promise<{ webSocketDebuggerUrl: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then(response => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = targets.find(target => target.type === 'page');
    if (page) return page;
    await delay(50);
  }
  throw new Error('Chrome page target was not created');
}

async function waitForExit(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  await new Promise<void>(resolvePromise => process.once('exit', () => resolvePromise()));
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      socket.addEventListener('open', () => resolvePromise(), { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), {
        once: true,
      });
    });
    return new CdpClient(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }) as {
      result: { value: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close(): void {
    this.socket.close();
  }
}

async function waitForExpression(cdp: CdpClient, expression: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await cdp.evaluate(expression)) return;
    await delay(50);
  }
  const state = await cdp.evaluate(`(() => ({
    text: document.body?.innerText ?? '',
    html: document.body?.innerHTML?.slice(0, 1200) ?? '',
    url: location.href,
  }))()`);
  throw new Error(`browser condition timed out: ${expression}\n${JSON.stringify(state)}`);
}
