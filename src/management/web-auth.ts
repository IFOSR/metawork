import { generateToken, tokenMatches } from './token.js';

export const WEB_SESSION_COOKIE = 'anyfusion_web_session';

export interface WebAuthServiceOptions {
  manualAccessToken?: string;
  createSessionToken?: () => string;
}

export interface WebAuthSessionState {
  readonly clientId: string;
}

export interface WebAuthExchangeResult extends WebAuthSessionState {
  readonly sessionToken: string;
}

export class WebAuthService {
  readonly manualAccessToken: string;
  private readonly sessions = new Map<string, WebAuthSessionState>();
  private readonly createSessionToken: () => string;

  constructor(private readonly options: WebAuthServiceOptions = {}) {
    this.manualAccessToken = options.manualAccessToken ?? generateToken();
    this.createSessionToken = options.createSessionToken ?? generateToken;
  }

  exchange(token: string): WebAuthExchangeResult | null {
    // 启动目录提示 token 不是登录凭据：只有手动访问 token 能换取会话。
    if (!tokenMatches(this.manualAccessToken, token)) return null;
    return this.createSession();
  }

  createSession(): WebAuthExchangeResult {
    const sessionToken = this.uniqueSessionToken();
    const state: WebAuthSessionState = { clientId: sessionToken };
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
