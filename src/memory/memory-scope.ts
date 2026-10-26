/**
 * Memory scope identity.
 *
 * Design §6.5 / D3 / D14: the account is the only isolation boundary. TDAI
 * enforces a `team_id + agent_id + user_id` triple, so every account gets one
 * fixed triple that is reused for every write and every recall. Deriving the
 * triple deterministically from the account id keeps the scope stable across
 * restarts and removes the need to register anything in the TDAI meta layer
 * (verified in Phase 0: the data plane accepts unregistered scope identifiers).
 *
 * Pure module: no repository, http or planner imports.
 */

import type { MemoryScope } from './memory-types.js';

const SCOPE_PREFIX = 'metawork';

/**
 * Stable, filesystem-safe scope component. TDAI rejects identifiers that
 * contain `/`, `\` or control characters and limits them to 256 bytes.
 */
function scopeSegment(kind: string, accountId: string): string {
  const normalized = accountId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64);
  return `${SCOPE_PREFIX}-${kind}-${normalized || 'default'}`;
}

/**
 * One fixed scope triple per account. All AgentClasses share the agent id so
 * that a memory learned in one role is recallable from every other role.
 */
export function deriveMemoryScope(accountId: string): MemoryScope {
  return {
    accountId,
    teamId: scopeSegment('team', accountId),
    agentId: scopeSegment('agent', accountId),
    userId: scopeSegment('user', accountId),
  };
}

/** TDAI v3 data-plane isolation fields. */
export function memoryScopeFields(scope: MemoryScope): {
  team_id: string;
  agent_id: string;
  user_id: string;
} {
  return {
    team_id: scope.teamId,
    agent_id: scope.agentId,
    user_id: scope.userId,
  };
}
