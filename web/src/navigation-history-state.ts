import type { WebSessionRecord } from './api/session-types';

/** Keep explicitly loaded older pages only when the refreshed range overlaps. */
export function mergeNewestHistoryPage(current: WebSessionRecord | null, incoming: WebSessionRecord): WebSessionRecord {
  if (!current || current.session.id !== incoming.session.id) return incoming;
  const ids = new Set(incoming.turns.map(turn => turn.id));
  if (!current.turns.some(turn => ids.has(turn.id))) return incoming;
  return {
    ...incoming,
    turns: [...current.turns.filter(turn => !ids.has(turn.id)), ...incoming.turns],
    historyCursor: current.historyCursor,
  };
}
