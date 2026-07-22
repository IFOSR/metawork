import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  CONTROLLED_CAPABILITIES,
  type CapabilityRequestInput,
} from '../resource/index.js';

export interface CapabilityRequestToolBinding {
  mcpUrl: string;
  jsonUrl: string;
  bearerToken: string;
}

export interface CapabilityRequestHandler {
  request(input: CapabilityRequestInput): Promise<unknown>;
}

const RequestSchema = z.object({
  capability: z.enum(CONTROLLED_CAPABILITIES),
  resource: z.string().trim().min(1).max(2048),
  operation: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(1).max(1000),
  suggestedScope: z.enum(['once', 'attempt']),
}).strict();

export class CapabilityRequestToolServer {
  private readonly bearerToken = randomBytes(32).toString('base64url');
  private readonly mcp = new McpServer({ name: 'metaclaw-capability-broker', version: '1.0.0' });
  private readonly transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  private readonly server = createServer((request, response) => { void this.handle(request, response); });

  constructor(
    private readonly handler: CapabilityRequestHandler,
    private readonly options: { bindHost?: string; advertisedHost?: string } = {},
  ) {
    this.mcp.registerTool('request_capability', {
      description: 'Request one concrete operation outside the Executor AgentClass default permission profile. Do not call for operations already allowed in the private workspace.',
      inputSchema: {
        capability: z.enum(CONTROLLED_CAPABILITIES),
        resource: z.string(),
        operation: z.string(),
        reason: z.string(),
        suggestedScope: z.enum(['once', 'attempt']),
      },
    }, async input => toolResult(await this.handler.request(RequestSchema.parse(input))));
  }

  async start(): Promise<CapabilityRequestToolBinding> {
    await this.mcp.connect(this.transport);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, this.options.bindHost ?? '0.0.0.0', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('capability broker did not bind a TCP port');
    const host = this.options.advertisedHost
      ?? (process.env.NODE_ENV === 'test' ? '127.0.0.1' : 'metaclaw-control');
    const base = `http://${host}:${address.port}`;
    return { mcpUrl: `${base}/mcp`, jsonUrl: `${base}/capability`, bearerToken: this.bearerToken };
  }

  async close(): Promise<void> {
    await this.transport.close().catch(() => undefined);
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${this.bearerToken}`) {
      sendJson(response, 401, { error: 'capability_request_not_authorized' });
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://metaclaw-control').pathname;
    if (pathname === '/mcp') {
      await this.transport.handleRequest(request, response);
      return;
    }
    if (pathname !== '/capability' || request.method !== 'POST') {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    try {
      const input = RequestSchema.parse(await readJson(request));
      sendJson(response, 200, await this.handler.request(input));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > 64 * 1024) reject(new Error('capability_request_too_large'));
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
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
