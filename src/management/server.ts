import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { Socket } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import type { MetaclawSession } from '../session/metaclaw-session.js';
import { SessionStreamAdapter } from '../session/session-transport-adapter.js';
import { bearerTokenFromHeader, tokenMatches } from './token';
import { WebSocketConnection } from './websocket';

export interface ManagementServerDeps {
  port: number;
  webDistDir: string;
  token: string;
  sessionFactory: (sessionId: string) => MetaclawSession;
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
  private singletonSession: MetaclawSession | null = null;
  private singletonSessionId: string | null = null;

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
    const key = request.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    this.handleWsConnection(socket, key);
  }

  private handleWsConnection(socket: Socket, key: string): void {
    WebSocketConnection.accept(socket, key);

    let authenticated = false;
    let adapter: SessionStreamAdapter | null = null;

    const ws = new WebSocketConnection(socket, {
      onMessage: text => {
        let message: { type?: string; token?: string; text?: string };
        try {
          message = JSON.parse(text) as { type?: string; token?: string; text?: string };
        } catch {
          ws.close();
          return;
        }

        if (!authenticated) {
          // 鉴权通过前拒绝一切非 auth 消息。
          if (message.type !== 'auth' || !message.token || !tokenMatches(this.deps.token, message.token)) {
            ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
            ws.close();
            return;
          }
          authenticated = true;
          const session = this.ensureSession();
          adapter = new SessionStreamAdapter(session, {
            onOutput: lines => ws.send(JSON.stringify({ type: 'output', lines })),
          });
          adapter.attach();
          ws.send(JSON.stringify({ type: 'hello', sessionId: this.singletonSessionId }));
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
        this.wsConnections.delete(ws);
      },
    });

    this.wsConnections.add(ws);
  }

  /** 单例 session：第一个鉴权通过的连接创建，后续连接附着。 */
  private ensureSession(): MetaclawSession {
    if (!this.singletonSession) {
      this.singletonSessionId = `sess_web_${nanoid(10)}`;
      this.singletonSession = this.deps.sessionFactory(this.singletonSessionId);
      this.singletonSession.initialize({ showDashboard: false });
    }
    return this.singletonSession;
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
    const provided = bearerTokenFromHeader(request.headers.authorization);
    if (!provided || !tokenMatches(this.deps.token, provided)) {
      this.sendJson(response, 401, { error: 'unauthorized' });
      return;
    }

    // REST 路由在第 4/5 步实现；第 3 步先返回未实现。
    this.sendJson(response, 501, { error: 'not implemented', path: url.pathname });
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
