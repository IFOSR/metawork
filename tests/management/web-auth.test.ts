import { describe, expect, it } from 'vitest';
import { WebAuthService } from '../../src/management/web-auth.js';

describe('WebAuthService', () => {
  it('exchanges bootstrap once and keeps manual fallback reusable', () => {
    let now = 1_000;
    const auth = new WebAuthService({
      bootstrapToken: 'bootstrap-token',
      manualAccessToken: 'manual-token',
      sessionToken: 'session-token',
      bootstrapTtlMs: 60_000,
      now: () => now,
    });

    expect(auth.exchange('bootstrap-token')).toBe(true);
    expect(auth.exchange('bootstrap-token')).toBe(false);
    expect(auth.exchange('manual-token')).toBe(true);
    expect(auth.exchange('manual-token')).toBe(true);

    now = 70_000;
    const expired = new WebAuthService({
      bootstrapToken: 'expired-token',
      manualAccessToken: 'manual-token',
      sessionToken: 'session-token',
      bootstrapTtlMs: 1_000,
      now: () => now,
      createdAt: 1_000,
    });
    expect(expired.exchange('expired-token')).toBe(false);
  });

  it('formats and validates an HttpOnly session cookie', () => {
    const auth = new WebAuthService({
      bootstrapToken: 'bootstrap-token',
      manualAccessToken: 'manual-token',
      sessionToken: 'session-token',
    });

    expect(auth.sessionCookie()).toBe(
      'anyfusion_web_session=session-token; HttpOnly; SameSite=Strict; Path=/',
    );
    expect(auth.hasSession('other=value; anyfusion_web_session=session-token')).toBe(true);
    expect(auth.hasSession('anyfusion_web_session=wrong')).toBe(false);
    expect(auth.clearSessionCookie()).toBe(
      'anyfusion_web_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    );
  });
});
