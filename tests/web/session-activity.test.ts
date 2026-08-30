import { describe, expect, it } from 'vitest';
import { resolveSessionActivity } from '../../web/src/session-activity';

describe('resolveSessionActivity', () => {
  it('lets a live running Turn override a stale blocked directory summary', () => {
    expect(resolveSessionActivity('blocked', true)).toBe('executing');
  });

  it('uses the directory summary when the Conversation has no live running Turn', () => {
    expect(resolveSessionActivity('blocked', false)).toBe('blocked');
    expect(resolveSessionActivity(undefined, false)).toBe('idle');
  });
});
