import { describe, expect, it } from 'vitest';
import { deriveMemoryScope, memoryScopeFields } from '../../src/memory/memory-scope.js';

/** The engine rejects / , backslash and control characters in scope identifiers. */
function hasUnsafeScopeCharacter(value: string): boolean {
  for (const character of value) {
    if (character === '/' || character === '\\') return true;
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

describe('memory scope identity', () => {
  it('derives one stable scope triple per account', () => {
    const first = deriveMemoryScope('local-default');
    const second = deriveMemoryScope('local-default');
    expect(first).toEqual(second);
  });

  it('never shares a scope between accounts', () => {
    const left = deriveMemoryScope('account-a');
    const right = deriveMemoryScope('account-b');
    expect(left.teamId).not.toBe(right.teamId);
    expect(left.agentId).not.toBe(right.agentId);
    expect(left.userId).not.toBe(right.userId);
  });

  it('uses one agent id for every role of an account', () => {
    // AgentClass is deliberately not part of the scope: a memory learned in one
    // role must be recallable from every other role (design D14).
    const scope = deriveMemoryScope('local-default');
    expect(scope.agentId).toBe(deriveMemoryScope('local-default').agentId);
    expect(scope.agentId).toContain('agent');
  });

  it('produces scope identifiers the engine accepts', () => {
    for (const accountId of ['local-default', 'account_1', 'a'.repeat(200)]) {
      const scope = deriveMemoryScope(accountId);
      for (const value of [scope.teamId, scope.agentId, scope.userId]) {
        expect(value.length).toBeLessThanOrEqual(256);
        expect(hasUnsafeScopeCharacter(value)).toBe(false);
        expect(value).not.toBe('.');
        expect(value).not.toBe('..');
      }
    }
  });

  it('falls back to a stable default for an unusable account id', () => {
    const scope = deriveMemoryScope('///');
    expect(scope.teamId).toBe('metawork-team-default');
    expect(scope.agentId).toBe('metawork-agent-default');
  });

  it('exposes the engine isolation fields', () => {
    const scope = deriveMemoryScope('local-default');
    expect(memoryScopeFields(scope)).toEqual({
      team_id: scope.teamId,
      agent_id: scope.agentId,
      user_id: scope.userId,
    });
  });
});
