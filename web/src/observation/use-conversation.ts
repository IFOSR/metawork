import { useCallback, useSyncExternalStore } from 'react';
import { ConversationEntityStore } from './conversation-store';
const empty = new ConversationEntityStore();
/**
 * The third argument is the same reader: these stores are client-side and have
 * no server snapshot, but supplying it keeps the hooks renderable outside the
 * browser (and therefore unit-testable) instead of throwing on mount.
 */
export function useConversationWindow(store: ConversationEntityStore | undefined, id: string) {
  const source = store ?? empty;
  const read = useCallback(() => source.window(id), [source, id]);
  return useSyncExternalStore(useCallback(notify => source.subscribe(id, notify), [source, id]), read, read);
}
export function useConversationTurn(store: ConversationEntityStore | undefined, id: string, turnId: string) {
  const source = store ?? empty;
  const read = useCallback(() => source.turn(id, turnId), [source, id, turnId]);
  return useSyncExternalStore(useCallback(notify => source.subscribeTurn(id, turnId, notify), [source, id, turnId]), read, read);
}
export function useConversationActivity(store: ConversationEntityStore | undefined, id: string) {
  const source = store ?? empty;
  const read = useCallback(() => source.activity(id), [source, id]);
  return useSyncExternalStore(useCallback(notify => source.subscribe(`${id}\0activity`, notify), [source, id]), read, read);
}
