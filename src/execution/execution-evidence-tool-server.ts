import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ExecutionEvidencePort } from './execution-evidence-port.js';

export interface ExecutionEvidenceToolBinding {
  mcpUrl: string;
  jsonUrl: string;
  bearerToken: string;
}

/** Hosts one attempt-scoped evidence capability for Codex MCP and Pi extension tools. */
export class ExecutionEvidenceToolServer {
  private readonly bearerToken = randomBytes(32).toString('base64url');
  private readonly mcp = new McpServer({ name: 'metaclaw-execution-evidence', version: '1.0.0' });
  private readonly transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  private readonly server = createServer((request, response) => { void this.handle(request, response); });

  constructor(
    private readonly port: ExecutionEvidencePort,
    private readonly options: { bindHost?: string; advertisedHost?: string } = {},
  ) {
    this.mcp.registerTool('evidence_list', {
      description: 'List user evidence authorized for this Task and attempt.',
      inputSchema: { cursor: z.string().optional(), limit: z.number().int().optional() },
    }, input => toolResult(this.port.list(input)));
    this.mcp.registerTool('evidence_search', {
      description: 'Search user evidence authorized for this Task and attempt.',
      inputSchema: { query: z.string(), cursor: z.string().optional(), limit: z.number().int().optional() },
    }, input => toolResult(this.port.search(input)));
    this.mcp.registerTool('evidence_get', {
      description: 'Read an authorized evidence item in bounded chunks.',
      inputSchema: { evidenceId: z.string(), offset: z.number().int().optional() },
    }, input => toolResult(this.port.get(input)));
  }

  async start(): Promise<ExecutionEvidenceToolBinding> {
    await this.mcp.connect(this.transport);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, this.options.bindHost ?? '0.0.0.0', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('evidence tool server did not bind a TCP port');
    const advertisedHost = this.options.advertisedHost
      ?? (process.env.NODE_ENV === 'test' ? '127.0.0.1' : 'metaclaw-control');
    const base = `http://${advertisedHost}:${address.port}`;
    return { mcpUrl: `${base}/mcp`, jsonUrl: `${base}/evidence`, bearerToken: this.bearerToken };
  }

  async close(): Promise<void> {
    await this.transport.close().catch(() => undefined);
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${this.bearerToken}`) {
      sendJson(response, 401, { error: 'evidence_not_authorized' });
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/mcp') {
      await this.transport.handleRequest(request, response);
      return;
    }
    if (pathname !== '/evidence' || request.method !== 'POST') {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    try {
      const body = await readJson(request);
      const operation = String(body.operation ?? '');
      const input = isRecord(body.input) ? body.input : {};
      const result = operation === 'list'
        ? this.port.list({ cursor: optionalString(input.cursor), limit: optionalNumber(input.limit) })
        : operation === 'search'
          ? this.port.search({ query: String(input.query ?? ''), cursor: optionalString(input.cursor), limit: optionalNumber(input.limit) })
          : operation === 'get'
            ? this.port.get({ evidenceId: String(input.evidenceId ?? ''), offset: optionalNumber(input.offset) })
            : null;
      if (result === null) throw new Error('unknown_evidence_operation');
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > 64 * 1024) reject(new Error('evidence_request_too_large'));
    });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        resolve(isRecord(parsed) ? parsed : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
