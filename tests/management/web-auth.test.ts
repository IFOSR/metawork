import { describe, expect, it } from 'vitest';
import { WebAuthService } from '../../src/management/web-auth.js';
import { WebLaunchContextService } from '../../src/management/web-launch-context.js';

describe('WebAuthService', () => {
  it('binds a consumed launch context to one per-browser session', () => {
    const launchContexts = new WebLaunchContextService({
      now: () => Date.parse('2026-08-27T08:00:00.000Z'),
      generateToken: () => 'launch-token',
    });
    const issued = launchContexts.issue({
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    });
    const auth = new WebAuthService({
      manualAccessToken: 'manual-token',
      launchContexts,
      createSessionToken: () => 'session-token-a',
    });

    expect(auth.exchange(issued.token)).toEqual({
      sessionToken: 'session-token-a',
      clientId: 'session-token-a',
      launchContext: {
        workspaceHint: '/repo-a',
        conversationId: 'conv_1',
      },
    });
    expect(auth.exchange(issued.token)).toBeNull();
    expect(auth.getSession('anyfusion_web_session=session-token-a')).toEqual({
      clientId: 'session-token-a',
      launchContext: {
        workspaceHint: '/repo-a',
        conversationId: 'conv_1',
      },
    });
  });

  it('keeps manual login reusable without fabricating a startup Workspace', () => {
    let counter = 0;
    const auth = new WebAuthService({
      manualAccessToken: 'manual-token',
      launchContexts: new WebLaunchContextService(),
      createSessionToken: () => `session-token-${counter += 1}`,
    });

    const first = auth.exchange('manual-token');
    const second = auth.exchange('manual-token');
    expect(first).toEqual({
      sessionToken: 'session-token-1',
      clientId: 'session-token-1',
      launchContext: null,
    });
    expect(second).toEqual({
      sessionToken: 'session-token-2',
      clientId: 'session-token-2',
      launchContext: null,
    });
    expect(auth.getSession('anyfusion_web_session=session-token-1')).toEqual({
      clientId: 'session-token-1',
      launchContext: null,
    });
    expect(auth.getSession('anyfusion_web_session=session-token-2')).toEqual({
      clientId: 'session-token-2',
      launchContext: null,
    });
  });

  it('formats, validates, isolates, and revokes HttpOnly session cookies', () => {
    const tokens = ['session-token-a', 'session-token-b'];
    const launchContexts = new WebLaunchContextService({
      generateToken: () => 'launch-token',
    });
    const auth = new WebAuthService({
      manualAccessToken: 'manual-token',
      launchContexts,
      createSessionToken: () => tokens.shift()!,
    });
    const launch = launchContexts.issue({ workspaceHint: '/repo-a' });
    const first = auth.exchange(launch.token)!;
    const second = auth.createSession();

    expect(auth.sessionCookie(first.sessionToken)).toBe(
      'anyfusion_web_session=session-token-a; HttpOnly; SameSite=Strict; Path=/',
    );
    expect(auth.hasSession('other=value; anyfusion_web_session=session-token-a')).toBe(true);
    expect(auth.hasSession('anyfusion_web_session=wrong')).toBe(false);
    expect(auth.getSession('anyfusion_web_session=session-token-a')?.launchContext)
      .toEqual({ workspaceHint: '/repo-a' });
    expect(auth.getSession('anyfusion_web_session=session-token-b')?.launchContext).toBeNull();

    auth.revokeSession('anyfusion_web_session=session-token-a');
    expect(auth.hasSession('anyfusion_web_session=session-token-a')).toBe(false);
    expect(auth.hasSession(`anyfusion_web_session=${second.sessionToken}`)).toBe(true);
    expect(auth.clearSessionCookie()).toBe(
      'anyfusion_web_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    );
  });
});
