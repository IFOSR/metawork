import { generateToken, tokenMatches } from './token.js';

export const WEB_SESSION_COOKIE = 'anyfusion_web_session';

const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_MS = 30_000;

export interface WebAuthServiceOptions {
  bootstrapToken?: string;
  manualAccessToken?: string;
  sessionToken?: string;
  bootstrapTtlMs?: number;
  now?: () => number;
  createdAt?: number;
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
