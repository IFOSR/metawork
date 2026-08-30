import type { WebSessionMetadata } from './api/session-types';

export type SessionActivityState = NonNullable<WebSessionMetadata['activity']>['state'];

export function resolveSessionActivity(
  directoryState: SessionActivityState | undefined,
  liveRunning: boolean,
): SessionActivityState {
  return liveRunning ? 'executing' : directoryState ?? 'idle';
}
