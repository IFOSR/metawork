import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { Socket } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import type { MetaclawSession } from '../session/metaclaw-session.js';
import { SessionStreamAdapter } from '../session/session-transport-adapter.js';
import { bearerTokenFromHeader, tokenMatches } from './token';
import { WebSocketConnection } from './websocket';
import type { ExecutionTimeline } from './execution-projector';
import type { WebAuthService } from './web-auth.js';

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

export interface ExecutionQuery {
  listTasks(): TaskSummary[];
  projectTimeline(taskId: string): ExecutionTimeline | null;
}

export interface ConfigSnapshotResponse {
  revisionId: string;
  runningRevisionId?: string;
  contentHash: string;
  config: unknown;
}

export interface RevisionSummary {
  revisionId: string;
  active: boolean;
}

export interface ActivateResult {
  ok: boolean;
  revisionId?: string;
  code?: string;
  activeRevisionId?: string | null;
  runningRevisionId?: string;
  restartRequired?: boolean;
  issues?: string[];
}

export interface ConfigQuery {
  getActive(): Promise<ConfigSnapshotResponse>;
  listRevisions(): Promise<RevisionSummary[]>;
  getSnapshot(revisionId: string): Promise<ConfigSnapshotResponse | null>;
  activate(baseRevisionId: string, config: unknown): Promise<ActivateResult>;
  rollback(targetRevisionId: string): Promise<ActivateResult>;
}

export interface ManagementServerDeps {
  port: number;
  webDistDir: string;
  token: string;
  webAuth: WebAuthService;
  runningRevisionId: string;
  webSocketAuthTimeoutMs?: number;
  sessionFactory: (sessionId: string) => MetaclawSession;
  executionQuery: ExecutionQuery;
  configQuery: ConfigQuery;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export class ManagementServer {
  private server: Server | null = null;
  private readonly wsConnections = new Set<WebSocketConnection>();
  private readonly authenticatedWsConnections = new Set<WebSocketConnection>();
  private singletonSession: MetaclawSession | null = null;
  private singletonSessionId: string | null = null;
  private lastTimelineJson: string | null = null;
  private lastTimeline: ExecutionTimeline | null = null;
  private lastTimelineTaskId: string | null = null;

  constructor(private readonly deps: ManagementServerDeps) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.on('upgrade', (request, socket) => {
      this.handleUpgrade(request, socket as Socket);
    });
    this.server = server;

    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(this.deps.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolvePromise();
      });
    });
  }

  async stop(): Promise<void> {
    for (const ws of this.wsConnections) {
      ws.close();
    }
    this.wsConnections.clear();
    this.authenticatedWsConnections.clear();
    if (this.singletonSession) {
      await this.singletonSession.dispose();
      this.singletonSession = null;
      this.singletonSessionId = null;
    }
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    });
  }

  get address(): string {
    return `http://127.0.0.1:${this.deps.port}`;
  }

  private handleUpgrade(request: IncomingMessage, socket: Socket): void {
    if (request.url !== '/ws') {
      socket.destroy();
      return;
    }
    if (!this.isAllowedWebSocketOrigin(request.headers.origin)) {
      this.rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (!this.deps.webAuth.hasSession(request.headers.cookie)) {
      this.rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    this.handleWsConnection(socket, key);
  }

  private handleWsConnection(socket: Socket, key: string): void {
    WebSocketConnection.accept(socket, key);

    let adapter: SessionStreamAdapter | null = null;
    let ws: WebSocketConnection;

    ws = new WebSocketConnection(socket, {
      onMessage: text => {
        let message: { type?: string; text?: string };
        try {
          message = JSON.parse(text) as { type?: string; text?: string };
        } catch {
          ws.close();
          return;
        }

        if (message.type === 'close') {
          ws.close();
          return;
        }
        if (message.type === 'input' && message.text) {
          void adapter?.submit(message.text).catch(error => {
            ws.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
          });
        }
      },
      onClose: () => {
        adapter?.detach();
        this.authenticatedWsConnections.delete(ws);
        this.wsConnections.delete(ws);
      },
    });

    this.wsConnections.add(ws);
    const session = this.ensureSession();
    adapter = new SessionStreamAdapter(session, {
      onOutput: (lines, from) => ws.send(JSON.stringify({ type: 'output', from, lines })),
    });
    adapter.attach();
    this.authenticatedWsConnections.add(ws);
    ws.send(JSON.stringify({ type: 'hello', sessionId: this.singletonSessionId }));
    // 新连接补发当前执行时间线：增量广播只发给当时已连接的客户端。
    if (this.lastTimelineTaskId && this.lastTimeline) {
      ws.send(JSON.stringify({
        type: 'execution',
        taskId: this.lastTimelineTaskId,
        timeline: this.lastTimeline,
      }));
    }
  }

  /** 单例 session：第一个鉴权通过的连接创建，后续连接附着。 */
  private ensureSession(): MetaclawSession {
    if (!this.singletonSession) {
      this.singletonSessionId = `sess_web_${nanoid(10)}`;
      this.singletonSession = this.deps.sessionFactory(this.singletonSessionId);
      this.singletonSession.initialize({ showDashboard: false });

      // 执行时间线增量推送：session 快照变化时投影当前 task 并 diff。
      this.singletonSession.subscribe(snapshot => {
        const taskId = snapshot.currentTaskId;
        if (!taskId) {
          this.lastTimeline = null;
          this.lastTimelineTaskId = null;
          return;
        }
        const timeline = this.deps.executionQuery.projectTimeline(taskId);
        if (!timeline) return;
        const json = JSON.stringify(timeline);
        if (json !== this.lastTimelineJson) {
          this.lastTimelineJson = json;
          this.lastTimeline = timeline;
          this.lastTimelineTaskId = taskId;
          this.broadcast({ type: 'execution', taskId, timeline });
        }
      });
    }
    return this.singletonSession;
  }

  private broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    for (const ws of this.authenticatedWsConnections) {
      ws.send(text);
    }
  }

  private isAllowedWebSocketOrigin(origin: string | undefined): boolean {
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      const hostname = parsed.hostname.toLowerCase();
      const port = parsed.port || (parsed.protocol === 'http:' ? '80' : '443');
      return parsed.protocol === 'http:'
        && (hostname === '127.0.0.1' || hostname === 'localhost')
        && port === String(this.deps.port);
    } catch {
      return false;
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname.startsWith('/api/')) {
      await this.handleApi(request, response, url);
      return;
    }

    await this.handleStatic(response, url.pathname);
  }

  private async handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method === 'POST' && url.pathname === '/api/auth/bootstrap') {
      if (!this.isAllowedWebSocketOrigin(request.headers.origin)) {
        this.sendJson(response, 403, { error: 'forbidden_origin' });
        return;
      }
      const body = await readRequestBody(request);
      if (!body.token || !this.deps.webAuth.exchange(body.token)) {
        this.sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      response.writeHead(204, { 'Set-Cookie': this.deps.webAuth.sessionCookie() });
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/session') {
      if (!this.deps.webAuth.hasSession(request.headers.cookie)) {
        this.sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      if (!this.isAllowedWebSocketOrigin(request.headers.origin)) {
        this.sendJson(response, 403, { error: 'forbidden_origin' });
        return;
      }
      response.writeHead(204, { 'Set-Cookie': this.deps.webAuth.clearSessionCookie() });
      response.end();
      return;
    }

    const provided = bearerTokenFromHeader(request.headers.authorization);
    const authenticated = this.deps.webAuth.hasSession(request.headers.cookie)
      || Boolean(provided && tokenMatches(this.deps.token, provided));
    if (!authenticated) {
      this.sendJson(response, 401, { error: 'unauthorized' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/execution/tasks') {
      this.sendJson(response, 200, this.deps.executionQuery.listTasks());
      return;
    }

    const taskMatch = /^\/api\/execution\/tasks\/([^/]+)$/u.exec(url.pathname);
    if (request.method === 'GET' && taskMatch) {
      const timeline = this.deps.executionQuery.projectTimeline(decodeURIComponent(taskMatch[1]));
      if (!timeline) {
        this.sendJson(response, 404, { error: 'task not found' });
        return;
      }
      this.sendJson(response, 200, timeline);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/config') {
      this.sendJson(response, 200, {
        ...await this.deps.configQuery.getActive(),
        runningRevisionId: this.deps.runningRevisionId,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/config/revisions') {
      this.sendJson(response, 200, await this.deps.configQuery.listRevisions());
      return;
    }

    const revisionMatch = /^\/api\/config\/revisions\/([^/]+)$/u.exec(url.pathname);
    if (request.method === 'GET' && revisionMatch) {
      const snapshot = await this.deps.configQuery.getSnapshot(decodeURIComponent(revisionMatch[1]));
      if (!snapshot) {
        this.sendJson(response, 404, { error: 'revision not found' });
        return;
      }
      this.sendJson(response, 200, snapshot);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/config/activate') {
      const body = await readRequestBody(request);
      if (!body.baseRevisionId || typeof body.config !== 'object') {
        this.sendJson(response, 400, { error: 'baseRevisionId and config are required' });
        return;
      }
      this.sendJson(
        response,
        200,
        this.withRuntimeRevision(
          await this.deps.configQuery.activate(body.baseRevisionId, body.config),
        ),
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/config/rollback') {
      const body = await readRequestBody(request);
      if (!body.targetRevisionId) {
        this.sendJson(response, 400, { error: 'targetRevisionId is required' });
        return;
      }
      this.sendJson(
        response,
        200,
        this.withRuntimeRevision(await this.deps.configQuery.rollback(body.targetRevisionId)),
      );
      return;
    }

    this.sendJson(response, 404, { error: 'not found', path: url.pathname });
  }

  private async handleStatic(response: ServerResponse, pathname: string): Promise<void> {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/u, '');
    const filePath = normalize(join(this.deps.webDistDir, relative));
    const root = resolve(this.deps.webDistDir);
    if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      const index = join(this.deps.webDistDir, 'index.html');
      if (!existsSync(index)) {
        this.sendText(response, 404, 'web dist not found; run `cd web && npm run build` first');
        return;
      }
      this.sendFile(response, index);
      return;
    }
    this.sendFile(response, filePath);
  }

  private sendFile(response: ServerResponse, filePath: string): void {
    const type = MIME[extname(filePath)] ?? 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(response);
  }

  private rejectUpgrade(socket: Socket, status: number, message: string): void {
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Length: 0\r\n'
      + '\r\n',
    );
  }

  private withRuntimeRevision(result: ActivateResult): ActivateResult {
    const activeRevisionId = result.ok
      ? result.revisionId ?? this.deps.runningRevisionId
      : result.activeRevisionId ?? this.deps.runningRevisionId;
    return {
      ...result,
      activeRevisionId,
      runningRevisionId: this.deps.runningRevisionId,
      restartRequired: activeRevisionId !== this.deps.runningRevisionId,
    };
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    this.sendText(response, status, `${JSON.stringify(body)}\n`, 'application/json; charset=utf-8');
  }

  private sendText(
    response: ServerResponse,
    status: number,
    body: string,
    contentType = 'text/plain; charset=utf-8',
  ): void {
    response.writeHead(status, { 'Content-Type': contentType });
    response.end(body);
  }
}

interface RequestBody {
  token?: string;
  baseRevisionId?: string;
  config?: unknown;
  targetRevisionId?: string;
}

function readRequestBody(request: IncomingMessage): Promise<RequestBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as RequestBody) : {});
      } catch (error) {
        reject(error as Error);
      }
    });
    request.on('error', reject);
  });
}
