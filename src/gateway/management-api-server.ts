// Local management API over a mode-0600 Unix socket. Public HTTP management,
// TLS, remote authentication, and rate limiting are intentionally not delivered.
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createJsonLineParser, encodeJsonLine } from './jsonl.js';
import type {
  ManagementApiRequest,
  ManagementApiResponse,
  ServerHealthResponse,
} from './management-api-protocol.js';

export interface ManagementApiServerDeps {
  socketPath: string;
  health(): Promise<ServerHealthResponse>;
}

export class ManagementApiServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly deps: ManagementApiServerDeps) {}

  async start(): Promise<void> {
    if (existsSync(this.deps.socketPath)) {
      unlinkSync(this.deps.socketPath);
    }
    this.server = createServer(socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      socket.once('error', () => this.sockets.delete(socket));
      void this.handleConnection(socket);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.deps.socketPath, resolve);
    });
    chmodSync(this.deps.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (this.server) {
      const server = this.server;
      await new Promise<void>(resolve => server.close(() => resolve()));
      this.server = null;
    }
    if (existsSync(this.deps.socketPath)) {
      unlinkSync(this.deps.socketPath);
    }
  }

  private async handleConnection(socket: Socket): Promise<void> {
    const parse = createJsonLineParser<ManagementApiRequest>(request => {
      void this.route(request).then(response => {
        if (!socket.destroyed) {
          socket.write(encodeJsonLine(response));
        }
      }).catch(error => {
        if (!socket.destroyed) {
          socket.write(encodeJsonLine({
            id: request.id,
            status: 500,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ManagementApiResponse));
        }
      });
    });
    socket.on('data', parse);
  }

  private async route(request: ManagementApiRequest): Promise<ManagementApiResponse> {
    if (request.path === '/api/v1/server/health' && request.method === 'GET') {
      return { id: request.id, status: 200, body: await this.deps.health() };
    }
    return {
      id: request.id,
      status: 404,
      error: `unknown management route: ${request.method} ${request.path}`,
    };
  }
}
