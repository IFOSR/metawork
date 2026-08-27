import { generateToken } from './token.js';

export interface WebLaunchContextInput {
  readonly workspaceHint: string;
  readonly conversationId?: string;
}

export interface WebLaunchContext extends WebLaunchContextInput {
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface IssuedWebLaunchContext {
  readonly token: string;
  readonly expiresAt: string;
}

export interface WebLaunchContextServiceOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly generateToken?: () => string;
}

const DEFAULT_LAUNCH_TTL_MS = 60_000;

export class WebLaunchContextService {
  private readonly contexts = new Map<string, WebLaunchContext>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly createToken: () => string;

  constructor(options: WebLaunchContextServiceOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_LAUNCH_TTL_MS;
    this.now = options.now ?? Date.now;
    this.createToken = options.generateToken ?? generateToken;
  }

  issue(input: WebLaunchContextInput): IssuedWebLaunchContext {
    const issuedAtMs = this.now();
    const expiresAtMs = issuedAtMs + this.ttlMs;
    const context: WebLaunchContext = {
      workspaceHint: input.workspaceHint,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    const token = this.uniqueToken();
    this.contexts.set(token, context);
    return { token, expiresAt: context.expiresAt };
  }

  consume(token: string): WebLaunchContext | null {
    const context = this.contexts.get(token);
    if (!context) return null;
    this.contexts.delete(token);
    if (this.now() > Date.parse(context.expiresAt)) return null;
    return context;
  }

  private uniqueToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.createToken();
      if (!this.contexts.has(token)) return token;
    }
    throw new Error('Unable to issue a unique Web launch token');
  }
}
