import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { Socket } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { bearerTokenFromHeader, tokenMatches } from './token';
import { WebSocketConnection } from './websocket';
import type { ExecutionTimeline } from './execution-projector';
import type { WorkGraphPresentationProjection } from './work-graph-presentation-projector.js';
import {
  MAX_ATTACHMENT_IMAGE_BYTES,
  type GatewayAttachmentStore,
} from '../gateway/attachment-store-port.js';
import type { ConfigurationRuntimeState } from '../configuration/configuration-runtime-coordinator.js';
import type { ConfigurationCompletionResult } from '../configuration/configuration-completion-service.js';
import { verifyLogin } from './login-credentials.js';
import { LoginThrottle } from './web-auth.js';
import type { LoginCredentials } from './login-credentials.js';
import type { WebAuthService } from './web-auth.js';
import type {
  ManagementWebSessionRuntime,
} from './web-session-runtime-types.js';
import type {
  ArtifactDownloadResult,
  ArtifactMetadataResult,
  ArtifactPreviewResult,
  ArtifactPreviewService,
} from './artifact-preview-service.js';

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

export interface ExecutionQuery {
  listTasks(): TaskSummary[];
  projectTimeline(taskId: string): ExecutionTimeline | null;
  projectWorkGraph?(taskId: string): WorkGraphPresentationProjection | null;
}

export interface ConfigSnapshotResponse {
  revisionId: string;
  runningRevisionId?: string;
  contentHash: string;
  config: unknown;
  runtime?: ConfigurationRuntimeState;
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
  activate(
    baseRevisionId: string,
    config: unknown,
    secrets?: Record<string, string>,
  ): Promise<ActivateResult>;
  rollback(targetRevisionId: string): Promise<ActivateResult>;
  writeSecret(providerRef: string, apiKey: string): Promise<{ apiKeyRef: string }>;
  /** 查询各 provider 的 secret 是否已配置。 */
  getSecretStatus(providerRefs: string[]): Promise<Record<string, boolean>>;
  /** 用存储的密钥调 Provider API 验证有效性；未配置时 valid 为 null。 */
  verifySecret(
    providerRef: string,
    baseUrl?: string,
  ): Promise<{ configured: boolean; valid: boolean | null; detail?: string }>;
  getCompletion?(): Promise<ConfigurationCompletionResult>;
}

export interface ConfigurationRuntimeStatusSource {
  getState(): ConfigurationRuntimeState;
  subscribe?(listener: (event: unknown) => void): () => void;
}

export type { ManagementWebSessionRuntime } from './web-session-runtime-types.js';

export interface ManagementServerDeps {
  port: number;
  webDistDir: string;
  token: string;
  webAuth: WebAuthService;
  runningRevisionId: string;
  webSocketAuthTimeoutMs?: number;
  sessionRuntime: ManagementWebSessionRuntime;
  /** 会话附件存储；未提供时上传端点返回 503。 */
  attachmentStore?: GatewayAttachmentStore;
  /** 同源 artifact 预览服务；未提供时 artifact 端点返回 503。 */
  artifactQuery?: ArtifactPreviewService;
  executionQuery: ExecutionQuery;
  configQuery: ConfigQuery;
  configurationRuntime?: ConfigurationRuntimeStatusSource;
  /** 账密登录凭据；未提供时登录端点返回 503。 */
  loginCredentials?: LoginCredentials;
  loginThrottle?: LoginThrottle;
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
  private sessionRuntimeUnsubscribe: (() => void) | null = null;
  private configurationRuntimeUnsubscribe: (() => void) | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly deps: ManagementServerDeps) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (this.stopping) throw new Error('ManagementServer is stopping');
    await this.deps.sessionRuntime.initialize();
    this.sessionRuntimeUnsubscribe = this.deps.sessionRuntime.subscribe(event => {
      this.broadcast(event);
    });
    this.configurationRuntimeUnsubscribe = this.deps.configurationRuntime?.subscribe?.(
      event => this.broadcast(event),
    ) ?? null;
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

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const server = this.server;
    this.server = null;
    const closeServer = server
      ? new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        })
      : Promise.resolve();
    for (const ws of this.wsConnections) {
      ws.close();
    }
    this.wsConnections.clear();
    this.authenticatedWsConnections.clear();
    this.sessionRuntimeUnsubscribe?.();
    this.sessionRuntimeUnsubscribe = null;
    this.configurationRuntimeUnsubscribe?.();
    this.configurationRuntimeUnsubscribe = null;
    this.stopPromise = Promise.all([
      closeServer,
      this.deps.sessionRuntime.dispose(),
    ]).then(() => undefined);
    return this.stopPromise;
  }

  get address(): string {
    return `http://127.0.0.1:${this.deps.port}`;
  }

  private handleUpgrade(request: IncomingMessage, socket: Socket): void {
    if (this.stopping) {
      socket.destroy();
      return;
    }
    if (request.url !== '/ws') {
      this.logWebSocketRejection(request, 'invalid_path');
      socket.destroy();
      return;
    }
    if (!this.isAllowedWebSocketOrigin(request.headers.origin)) {
      this.logWebSocketRejection(request, 'forbidden_origin');
      this.rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (!this.deps.webAuth.hasSession(request.headers.cookie)) {
      this.logWebSocketRejection(request, 'unauthorized');
      this.rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (!key) {
      this.logWebSocketRejection(request, 'missing_websocket_key');
      socket.destroy();
      return;
    }
    this.handleWsConnection(socket, key);
  }

  private handleWsConnection(socket: Socket, key: string): void {
    WebSocketConnection.accept(socket, key);

    let ws: WebSocketConnection;

    ws = new WebSocketConnection(socket, {
      onMessage: text => {
        let message: { type?: string; text?: string; attachments?: Array<{ attachmentId?: unknown }> };
        try {
          message = JSON.parse(text) as typeof message;
        } catch {
          ws.close();
          return;
        }

        if (message.type === 'close') {
          ws.close();
          return;
        }
        if (message.type === 'input' && message.text) {
          const attachments = (message.attachments ?? [])
            .filter(entry => typeof entry?.attachmentId === 'string')
            .map(entry => ({ attachmentId: entry.attachmentId as string, kind: 'file' }));
          void this.deps.sessionRuntime.submit(message.text, attachments).catch(error => {
            ws.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
          });
        }
      },
      onClose: () => {
        this.authenticatedWsConnections.delete(ws);
        this.wsConnections.delete(ws);
      },
    });

    this.wsConnections.add(ws);
    this.authenticatedWsConnections.add(ws);
    ws.send(JSON.stringify({
      type: 'hello',
      sessionId: this.deps.sessionRuntime.activeSessionId,
    }));
    for (const event of this.deps.sessionRuntime.getReplayEvents()) {
      ws.send(JSON.stringify(event));
    }
  }

  private broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    for (const ws of this.authenticatedWsConnections) {
      ws.send(text);
    }
  }

  private async handleAttachmentUpload(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const store = this.deps.attachmentStore;
    if (!store) {
      this.sendJson(response, 503, { error: 'attachment uploads disabled' });
      return;
    }
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const name = url.searchParams.get('name') ?? '';
    if (!sessionId || !name) {
      this.sendJson(response, 400, { error: 'sessionId and name query parameters are required' });
      return;
    }
    const maxBytes = MAX_ATTACHMENT_IMAGE_BYTES + 1;
    const bytes = await readRawBody(request, maxBytes);
    if (bytes === null) {
      this.sendJson(response, 413, { error: 'attachment too large' });
      return;
    }
    try {
      const metadata = await store.saveAttachment({ sessionId, name, bytes });
      this.sendJson(response, 201, metadata);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /too large|size limit/iu.test(message)
        ? 413
        : /type|mime|image|text/iu.test(message) ? 415 : 400;
      this.sendJson(response, status, { error: message });
    }
  }

  private async handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.deps.loginCredentials) {
      this.sendJson(response, 503, { error: 'password login disabled' });
      return;
    }
    if (!this.isAllowedWebSocketOrigin(request.headers.origin)) {
      this.sendJson(response, 403, { error: 'forbidden_origin' });
      return;
    }
    const throttle = this.deps.loginThrottle ??= new LoginThrottle();
    const clientKey = clientAddressOf(request);
    if (throttle.isLocked(clientKey)) {
      this.sendJson(response, 429, { error: 'too many attempts; try again later' });
      return;
    }
    const body = await readRequestBody(request);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      this.sendJson(response, 400, { error: 'username and password are required' });
      return;
    }
    if (!verifyLogin(username, password, this.deps.loginCredentials)) {
      throttle.registerFailure(clientKey);
      this.sendJson(response, 401, { error: 'invalid username or password' });
      return;
    }
    throttle.registerSuccess(clientKey);
    response.writeHead(204, { 'Set-Cookie': this.deps.webAuth.sessionCookie() });
    response.end();
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
    if (this.stopping) {
      response.writeHead(503);
      response.end();
      return;
    }
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

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      await this.handleLogin(request, response);
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

    if (request.method === 'GET' && url.pathname === '/api/ws/diagnostics') {
      const diagnostic = this.getWebSocketDiagnostic(request);
      this.sendJson(response, diagnostic.status, {
        ok: diagnostic.ok,
        reason: diagnostic.reason,
        message: diagnostic.message,
      });
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

    if (request.method === 'POST' && url.pathname === '/api/attachments') {
      await this.handleAttachmentUpload(request, response, url);
      return;
    }

    const artifactPreviewMatch = /^\/api\/artifacts\/([^/]+)\/preview$/u.exec(url.pathname);
    if (request.method === 'GET' && artifactPreviewMatch) {
      await this.handleArtifactPreview(response, decodeURIComponent(artifactPreviewMatch[1]!));
      return;
    }

    const artifactDownloadMatch = /^\/api\/artifacts\/([^/]+)\/download$/u.exec(url.pathname);
    if (request.method === 'GET' && artifactDownloadMatch) {
      await this.handleArtifactDownload(request, response, decodeURIComponent(artifactDownloadMatch[1]!));
      return;
    }

    const artifactMatch = /^\/api\/artifacts\/([^/]+)$/u.exec(url.pathname);
    if (request.method === 'GET' && artifactMatch) {
      await this.handleArtifactMetadata(response, decodeURIComponent(artifactMatch[1]!));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/execution/tasks') {
      this.sendJson(response, 200, this.deps.executionQuery.listTasks());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      this.sendJson(response, 200, {
        activeSessionId: this.deps.sessionRuntime.activeSessionId,
        sessions: await this.deps.sessionRuntime.listSessions(url.searchParams.get('q') ?? ''),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      const body = await readRequestBody(request);
      this.sendJson(
        response,
        201,
        await this.deps.sessionRuntime.createSession(body.title),
      );
      return;
    }

    // 注意：必须在通配的 /api/sessions/:id 之前匹配。
    if (request.method === 'POST' && url.pathname === '/api/sessions/clear-all') {
      this.sendJson(response, 200, await this.deps.sessionRuntime.clearAllSessions());
      return;
    }

    const sessionActivateMatch = /^\/api\/sessions\/([^/]+)\/activate$/u.exec(url.pathname);
    if (request.method === 'POST' && sessionActivateMatch) {
      this.sendJson(
        response,
        200,
        await this.deps.sessionRuntime.activateSession(
          decodeURIComponent(sessionActivateMatch[1]!),
        ),
      );
      return;
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)$/u.exec(url.pathname);
    if (request.method === 'DELETE' && sessionMatch) {
      const outcome = await this.deps.sessionRuntime.deleteSession(
        decodeURIComponent(sessionMatch[1]!),
      );
      if (outcome === 'active') {
        this.sendJson(response, 409, { error: 'session is active; switch away before deleting' });
        return;
      }
      if (outcome === 'not_found') {
        this.sendJson(response, 404, { error: 'session not found' });
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === 'GET' && sessionMatch) {
      const record = await this.deps.sessionRuntime.readSession(
        decodeURIComponent(sessionMatch[1]!),
      );
      if (!record) {
        this.sendJson(response, 404, { error: 'session not found' });
        return;
      }
      this.sendJson(response, 200, record);
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

    const workGraphMatch = /^\/api\/execution\/tasks\/([^/]+)\/work-graph$/u.exec(url.pathname);
    if (request.method === 'GET' && workGraphMatch) {
      const projection = this.deps.executionQuery.projectWorkGraph?.(
        decodeURIComponent(workGraphMatch[1]!),
      );
      if (!projection) {
        this.sendJson(response, 404, { error: 'work graph not found' });
        return;
      }
      this.sendJson(response, 200, projection);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/config') {
      this.sendJson(response, 200, {
        ...await this.deps.configQuery.getActive(),
        runningRevisionId: this.deps.runningRevisionId,
        ...(this.deps.configurationRuntime?.getState() ?? {}),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/config/activation-status') {
      const runtime = this.deps.configurationRuntime?.getState();
      if (!runtime) {
        this.sendJson(response, 503, { error: 'configuration runtime status unavailable' });
        return;
      }
      this.sendJson(response, 200, runtime);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/config/completion') {
      if (!this.deps.configQuery.getCompletion) {
        this.sendJson(response, 503, { error: 'configuration completion unavailable' });
        return;
      }
      this.sendJson(response, 200, await this.deps.configQuery.getCompletion());
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
      const secrets = isRecord(body.secrets)
        ? Object.fromEntries(Object.entries(body.secrets).filter(
          ([providerRef, value]) => isSafeProviderRef(providerRef) && typeof value === 'string',
        ))
        : undefined;
      const result = this.withRuntimeRevision(
        await this.deps.configQuery.activate(body.baseRevisionId, body.config, secrets),
      );
      const status = result.code === 'runtime_busy' || result.code === 'restart_required'
        || result.code === 'revision_conflict' ? 409
          : result.code === 'invalid_configuration' ? 422
            : 200;
      this.sendJson(response, status, result);
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

    if (request.method === 'GET' && url.pathname === '/api/config/secrets/status') {
      const refs = (url.searchParams.get('providers') ?? '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .slice(0, 64);
      this.sendJson(response, 200, await this.deps.configQuery.getSecretStatus(refs));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/config/secrets/verify') {
      const body = await readRequestBody(request);
      if (!body.providerRef) {
        this.sendJson(response, 400, { error: 'providerRef is required' });
        return;
      }
      this.sendJson(
        response,
        200,
        await this.deps.configQuery.verifySecret(body.providerRef, body.baseUrl),
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/config/secrets') {
      const body = await readRequestBody(request);
      if (!body.providerRef || !body.apiKey) {
        this.sendJson(response, 400, { error: 'providerRef and apiKey are required' });
        return;
      }
      this.sendJson(response, 200, await this.deps.configQuery.writeSecret(body.providerRef, body.apiKey));
      return;
    }

    this.sendJson(response, 404, { error: 'not found', path: url.pathname });
  }

  private artifactFailureStatus(reason: string): number {
    if (reason === 'unauthorized') return 403;
    if (reason === 'unavailable') return 410;
    if (reason === 'unsupported') return 415;
    return 404;
  }

  private async handleArtifactMetadata(
    response: ServerResponse,
    artifactId: string,
  ): Promise<void> {
    const service = this.deps.artifactQuery;
    if (!service) {
      this.sendJson(response, 503, { error: 'artifact preview unavailable' });
      return;
    }
    const result: ArtifactMetadataResult = await service.getMetadata(artifactId);
    if (!result.ok) {
      this.sendJson(response, this.artifactFailureStatus(result.reason), { error: result.reason });
      return;
    }
    this.sendJson(response, 200, { artifact: result.artifact });
  }

  private async handleArtifactPreview(
    response: ServerResponse,
    artifactId: string,
  ): Promise<void> {
    const service = this.deps.artifactQuery;
    if (!service) {
      this.sendJson(response, 503, { error: 'artifact preview unavailable' });
      return;
    }
    const result: ArtifactPreviewResult = await service.readPreview(artifactId);
    if (!result.ok) {
      this.sendJson(response, this.artifactFailureStatus(result.reason), { error: result.reason });
      return;
    }
    this.sendJson(response, 200, {
      artifact: result.artifact,
      content: result.content,
      ...(result.renderedHtml ? { renderedHtml: result.renderedHtml } : {}),
    });
  }

  private async handleArtifactDownload(
    request: IncomingMessage,
    response: ServerResponse,
    artifactId: string,
  ): Promise<void> {
    const service = this.deps.artifactQuery;
    if (!service) {
      this.sendJson(response, 503, { error: 'artifact preview unavailable' });
      return;
    }
    const result: ArtifactDownloadResult = await service.resolveDownload(artifactId);
    if (!result.ok) {
      this.sendJson(response, this.artifactFailureStatus(result.reason), { error: result.reason });
      return;
    }
    let filePath: string;
    try {
      filePath = result.absolutePath;
      const dispositionName = result.artifact.displayName.replace(/[^\w.\-\u4e00-\u9fff]+/gu, '_');
      response.writeHead(200, {
        'Content-Type': result.artifact.mediaType,
        'Content-Length': result.artifact.byteLength,
        'Cache-Control': 'no-cache',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(dispositionName)}`,
        'X-Content-Type-Options': 'nosniff',
      });
      createReadStream(filePath).pipe(response);
      return;
    } catch (error) {
      if (!response.headersSent) {
        this.sendJson(response, 410, { error: 'unavailable', detail: (error as Error).message });
        return;
      }
      response.destroy(error as Error);
    }
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

  private getWebSocketDiagnostic(request: IncomingMessage): WebSocketDiagnostic {
    if (!this.isAllowedWebSocketOrigin(request.headers.origin)) {
      return {
        ok: false,
        status: 403,
        reason: 'forbidden_origin',
        message: 'WebSocket Origin 与服务端端口不匹配。',
      };
    }
    if (!this.deps.webAuth.hasSession(request.headers.cookie)) {
      return {
        ok: false,
        status: 401,
        reason: 'unauthorized',
        message: 'Web 会话 Cookie 无效或已过期。',
      };
    }
    return {
      ok: true,
      status: 200,
      reason: 'ready',
      message: 'WebSocket 可以连接。',
    };
  }

  private logWebSocketRejection(request: IncomingMessage, reason: string): void {
    console.warn('[AnyFusion Web] WebSocket 握手拒绝', {
      path: request.url ?? '/',
      origin: request.headers.origin ?? null,
      hasSessionCookie: this.deps.webAuth.hasSession(request.headers.cookie),
      reason,
    });
  }

  private withRuntimeRevision(result: ActivateResult): ActivateResult {
    const runtime = this.deps.configurationRuntime?.getState();
    const activeRevisionId = result.ok
      ? result.revisionId ?? runtime?.activeRevisionId ?? this.deps.runningRevisionId
      : result.activeRevisionId ?? runtime?.activeRevisionId ?? this.deps.runningRevisionId;
    const runtimeRevisionId = runtime?.runtimeRevisionId ?? this.deps.runningRevisionId;
    return {
      ...result,
      activeRevisionId,
      runningRevisionId: runtimeRevisionId,
      restartRequired: result.restartRequired ?? activeRevisionId !== runtimeRevisionId,
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
  username?: string;
  password?: string;
  baseRevisionId?: string;
  config?: unknown;
  targetRevisionId?: string;
  providerRef?: string;
  baseUrl?: string;
  apiKey?: string;
  secrets?: Record<string, string>;
  title?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeProviderRef(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/u.test(value);
}

interface WebSocketDiagnostic {
  ok: boolean;
  status: number;
  reason: 'ready' | 'forbidden_origin' | 'unauthorized';
  message: string;
}

function clientAddressOf(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown';
}

function readRawBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    request.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        overflow = true;
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!overflow) resolve(Buffer.concat(chunks));
    });
    request.on('error', error => {
      if (overflow) resolve(null);
      else reject(error as Error);
    });
  });
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
