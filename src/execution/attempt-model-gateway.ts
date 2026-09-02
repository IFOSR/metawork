import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';

export interface AttemptModelGatewayBinding {
  baseUrl: string;
  apiKey: string;
}

/**
 * Attempt-scoped model proxy. The container receives only a random bearer
 * token and an internal-network URL; the trusted Runtime retains the provider
 * URL and credential and permits no caller-selected destination.
 */
export class AttemptModelGatewayServer {
  private readonly attemptToken = randomBytes(32).toString('base64url');
  private readonly server = createServer((request, response) => { void this.handle(request, response); });
  private readonly upstream: URL;

  constructor(private readonly options: {
    upstreamBaseUrl: string;
    upstreamApiKey: string;
    advertisedHost?: string;
    bindHost?: string;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
  }) {
    this.upstream = new URL(options.upstreamBaseUrl);
    if (!['http:', 'https:'].includes(this.upstream.protocol)) throw new Error('model gateway upstream must use HTTP(S)');
    if (!options.upstreamApiKey.trim()) throw new Error('model gateway upstream API key is required');
  }

  async start(): Promise<AttemptModelGatewayBinding> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, this.options.bindHost ?? '0.0.0.0', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('attempt model gateway did not bind a TCP port');
    const host = this.options.advertisedHost ?? process.env.METACLAW_CONTROL_HOST ?? 'metaclaw-control';
    const basePath = this.upstream.pathname.replace(/\/$/u, '');
    return {
      baseUrl: `http://${host}:${address.port}${basePath}`,
      apiKey: this.attemptToken,
    };
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${this.attemptToken}`) {
      sendJson(response, 401, { error: 'model_gateway_not_authorized' });
      return;
    }
    try {
      const body = await readBoundedBody(request, this.options.maxRequestBytes ?? 4 * 1024 * 1024);
      const incomingUrl = new URL(request.url ?? '/', 'http://metaclaw-control');
      const upstreamUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, this.upstream.origin);
      const upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: forwardedHeaders(request.headers, this.options.upstreamApiKey),
        body: body.length > 0 ? new Uint8Array(body) : undefined,
        redirect: 'manual',
      });
      response.statusCode = upstreamResponse.status;
      for (const header of ['content-type', 'cache-control', 'openai-processing-ms', 'x-request-id']) {
        const value = upstreamResponse.headers.get(header);
        if (value) response.setHeader(header, value);
      }
      if (!upstreamResponse.body) {
        response.end();
        return;
      }
      const payload = Buffer.from(await upstreamResponse.arrayBuffer());
      if (payload.length > (this.options.maxResponseBytes ?? 64 * 1024 * 1024)) {
        throw new Error('model gateway response exceeds byte limit');
      }
      response.end(payload);
    } catch (error) {
      if (!response.headersSent) sendJson(response, 502, { error: 'model_gateway_upstream_failure' });
      else response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function forwardedHeaders(headers: IncomingHttpHeaders, upstreamApiKey: string): Headers {
  const forwarded = new Headers();
  for (const name of ['accept', 'content-type', 'openai-organization', 'openai-project', 'user-agent']) {
    const value = headers[name];
    if (typeof value === 'string') forwarded.set(name, value);
    else if (Array.isArray(value)) forwarded.set(name, value.join(', '));
  }
  forwarded.set('authorization', `Bearer ${upstreamApiKey}`);
  return forwarded;
}

function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        reject(new Error('model gateway request exceeds byte limit'));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}
