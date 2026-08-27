import { generateToken, tokenMatches } from './token.js';
import type {
  WebLaunchContextInput,
  WebLaunchContextService,
} from './web-launch-context.js';

export const WEB_SESSION_COOKIE = 'anyfusion_web_session';

const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_MS = 30_000;

export interface WebAuthServiceOptions {
  manualAccessToken?: string;
  launchContexts: WebLaunchContextService;
  createSessionToken?: () => string;
}

export interface WebAuthSessionState {
  readonly launchContext: WebLaunchContextInput | null;
}

export interface WebAuthExchangeResult extends WebAuthSessionState {
  readonly sessionToken: string;
}

/** 内存级登录防爆破：同 IP 连续失败 5 次锁定 30 秒。 */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  isLocked(key: string): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (entry.lockedUntil > this.now()) return true;
    if (entry.lockedUntil !== 0 && entry.lockedUntil <= this.now()) {
      this.failures.delete(key);
    }
    return false;
  }

  registerFailure(key: string): void {
    const entry = this.failures.get(key) ?? { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= MAX_LOGIN_FAILURES) {
      entry.lockedUntil = this.now() + LOCKOUT_MS;
      entry.count = 0;
    }
    this.failures.set(key, entry);
  }

  registerSuccess(key: string): void {
    this.failures.delete(key);
  }
}

export class WebAuthService {
  readonly manualAccessToken: string;
  private readonly sessions = new Map<string, WebAuthSessionState>();
  private readonly createSessionToken: () => string;

  constructor(private readonly options: WebAuthServiceOptions) {
    this.manualAccessToken = options.manualAccessToken ?? generateToken();
    this.createSessionToken = options.createSessionToken ?? generateToken;
  }

  exchange(token: string): WebAuthExchangeResult | null {
    const launch = this.options.launchContexts.consume(token);
    if (launch) {
      return this.createSession({
        workspaceHint: launch.workspaceHint,
        ...(launch.conversationId ? { conversationId: launch.conversationId } : {}),
      });
    }
    if (!tokenMatches(this.manualAccessToken, token)) return null;
    return this.createSession();
  }

  createSession(launchContext: WebLaunchContextInput | null = null): WebAuthExchangeResult {
    const sessionToken = this.uniqueSessionToken();
    const state = {
      launchContext: launchContext
        ? {
          workspaceHint: launchContext.workspaceHint,
          ...(launchContext.conversationId
            ? { conversationId: launchContext.conversationId }
            : {}),
        }
        : null,
    };
    this.sessions.set(sessionToken, state);
    return { sessionToken, ...state };
  }

  hasSession(cookieHeader: string | undefined): boolean {
    return this.getSession(cookieHeader) !== null;
  }

  getSession(cookieHeader: string | undefined): WebAuthSessionState | null {
    const token = cookieValue(cookieHeader, WEB_SESSION_COOKIE);
    if (!token) return null;
    return this.sessions.get(token) ?? null;
  }

  sessionCookie(sessionToken: string): string {
    return `${WEB_SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`;
  }

  revokeSession(cookieHeader: string | undefined): void {
    const token = cookieValue(cookieHeader, WEB_SESSION_COOKIE);
    if (token) this.sessions.delete(token);
  }

  clearSessionCookie(): string {
    return `${WEB_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  private uniqueSessionToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.createSessionToken();
      if (!this.sessions.has(token)) return token;
    }
    throw new Error('Unable to create a unique Web session');
  }
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}
