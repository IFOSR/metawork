import { generateToken, tokenMatches } from './token.js';

export const WEB_SESSION_COOKIE = 'anyfusion_web_session';

export interface WebAuthServiceOptions {
  bootstrapToken?: string;
  manualAccessToken?: string;
  sessionToken?: string;
  bootstrapTtlMs?: number;
  now?: () => number;
  createdAt?: number;
}

export class WebAuthService {
  readonly bootstrapToken: string;
  readonly manualAccessToken: string;
  private readonly sessionToken: string;
  private readonly expiresAt: number;
  private readonly now: () => number;
  private bootstrapConsumed = false;

  constructor(options: WebAuthServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.bootstrapToken = options.bootstrapToken ?? generateToken();
    this.manualAccessToken = options.manualAccessToken ?? generateToken();
    this.sessionToken = options.sessionToken ?? generateToken();
    this.expiresAt = (options.createdAt ?? this.now()) + (options.bootstrapTtlMs ?? 60_000);
  }

  exchange(token: string): boolean {
    if (tokenMatches(this.manualAccessToken, token)) return true;
    if (
      this.bootstrapConsumed
      || this.now() > this.expiresAt
      || !tokenMatches(this.bootstrapToken, token)
    ) {
      return false;
    }
    this.bootstrapConsumed = true;
    return true;
  }

  hasSession(cookieHeader: string | undefined): boolean {
    const provided = cookieValue(cookieHeader, WEB_SESSION_COOKIE);
    return Boolean(provided && tokenMatches(this.sessionToken, provided));
  }

  sessionCookie(): string {
    return `${WEB_SESSION_COOKIE}=${this.sessionToken}; HttpOnly; SameSite=Strict; Path=/`;
  }

  clearSessionCookie(): string {
    return `${WEB_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
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
