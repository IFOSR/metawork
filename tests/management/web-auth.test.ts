import { describe, expect, it } from 'vitest';
import { WebAuthService } from '../../src/management/web-auth.js';

describe('WebAuthService', () => {
  it('rejects an issued launch token as a login credential', () => {
    const auth = new WebAuthService({ manualAccessToken: 'manual-token' });

    expect(auth.exchange('launch-token')).toBeNull();
    expect(auth.getSession('anyfusion_web_session=launch-token')).toBeNull();
  });

  it('keeps manual login reusable without fabricating a launch context', () => {
    let counter = 0;
    const auth = new WebAuthService({
      manualAccessToken: 'manual-token',
      createSessionToken: () => `session-token-${counter += 1}`,
    });

    const first = auth.exchange('manual-token');
    const second = auth.exchange('manual-token');
    expect(first).toEqual({
      sessionToken: 'session-token-1',
      clientId: 'session-token-1',
    });
    expect(second).toEqual({
      sessionToken: 'session-token-2',
      clientId: 'session-token-2',
    });
    expect(auth.getSession('anyfusion_web_session=session-token-1')).toEqual({
      clientId: 'session-token-1',
    });
    expect(auth.getSession('anyfusion_web_session=session-token-2')).toEqual({
      clientId: 'session-token-2',
    });
  });

  it('formats, validates, isolates, and revokes HttpOnly session cookies', () => {
    const tokens = ['session-token-a', 'session-token-b'];
    const auth = new WebAuthService({
      manualAccessToken: 'manual-token',
      createSessionToken: () => tokens.shift()!,
    });

    const first = auth.createSession();
    const second = auth.createSession();
    expect(first.clientId).toBe('session-token-a');
    expect(second.clientId).toBe('session-token-b');
    expect(auth.sessionCookie(first.sessionToken)).toBe(
      'anyfusion_web_session=session-token-a; HttpOnly; SameSite=Strict; Path=/',
    );
    expect(auth.hasSession('anyfusion_web_session=unknown')).toBe(false);
    expect(auth.clearSessionCookie()).toBe(
      'anyfusion_web_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    );

    auth.revokeSession('anyfusion_web_session=session-token-a');
    expect(auth.getSession('anyfusion_web_session=session-token-a')).toBeNull();
    expect(auth.getSession('anyfusion_web_session=session-token-b')).toEqual({
      clientId: 'session-token-b',
    });
  });
});
