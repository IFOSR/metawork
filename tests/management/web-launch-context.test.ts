import { describe, expect, it } from 'vitest';
import {
  WebLaunchContextService,
} from '../../src/management/web-launch-context.js';

describe('WebLaunchContextService', () => {
  it('issues a high-entropy one-time launch token with a short TTL', () => {
    let now = Date.parse('2026-08-27T08:00:00.000Z');
    const service = new WebLaunchContextService({
      now: () => now,
      ttlMs: 60_000,
    });

    const issued = service.issue({
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    });

    expect(issued.token.length).toBeGreaterThanOrEqual(40);
    expect(issued.expiresAt).toBe('2026-08-27T08:01:00.000Z');
    expect(service.consume(issued.token)).toEqual({
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
      issuedAt: '2026-08-27T08:00:00.000Z',
      expiresAt: '2026-08-27T08:01:00.000Z',
    });
    expect(service.consume(issued.token)).toBeNull();

    now += 1;
    expect(service.issue({ workspaceHint: '/repo-b' }).token).not.toBe(issued.token);
  });

  it('rejects expired tokens without exposing their launch context', () => {
    let now = 1_000;
    const service = new WebLaunchContextService({
      now: () => now,
      ttlMs: 500,
      generateToken: () => 'deterministic-expired-token',
    });
    const issued = service.issue({ workspaceHint: '/repo-private' });

    now = 1_501;
    expect(service.consume(issued.token)).toBeNull();
    expect(service.consume(issued.token)).toBeNull();
  });
});
