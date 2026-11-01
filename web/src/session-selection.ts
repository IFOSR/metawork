import type { WebSessionMetadata } from './api/session-types';

/** Restore only an explicit client selection; directory recency is never a target. */
export function selectInitialSessionId(
  sessions: WebSessionMetadata[],
  requestedSessionId: string | null,
): string | null {
  return requestedSessionId && sessions.some(session => session.id === requestedSessionId && !session.archived)
    ? requestedSessionId : null;
}
