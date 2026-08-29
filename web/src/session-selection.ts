import type { WebSessionMetadata } from './api/session-types';

/**
 * Pick the conversation the Web client should open without creating one.
 * Explicit launch intent wins; otherwise prefer the server's active session,
 * then the most recently updated session in the selected Workspace.
 */
export function selectInitialSessionId(
  sessions: WebSessionMetadata[],
  requestedSessionId: string | null,
  activeSessionId: string | null,
): string | null {
  if (requestedSessionId && sessions.some(session => session.id === requestedSessionId)) {
    return requestedSessionId;
  }
  if (activeSessionId && sessions.some(session => session.id === activeSessionId)) {
    return activeSessionId;
  }
  const substantiveSessions = sessions.filter(session => (
    session.title.trim() !== 'New conversation'
    || Boolean(session.preview?.trim() && session.preview.trim() !== 'New conversation')
  ));
  const candidates = substantiveSessions.length > 0 ? substantiveSessions : sessions;
  return [...candidates]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]?.id ?? null;
}
