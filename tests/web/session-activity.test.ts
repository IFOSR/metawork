import { describe, expect, it } from 'vitest';
import { resolveSessionActivity } from '../../web/src/session-activity';

describe('resolveSessionActivity', () => {
  it('never overwrites authoritative activity with a generic running Turn', () => {
    for (const state of ['queued', 'planning', 'waiting', 'blocked', 'idle'] as const) {
      expect(resolveSessionActivity(state, true)).toBe(state);
    }
  });

  it('uses the directory summary when the Conversation has no live running Turn', () => {
    expect(resolveSessionActivity('blocked', false)).toBe('blocked');
    expect(resolveSessionActivity(undefined, false)).toBe('idle');
  });
});
