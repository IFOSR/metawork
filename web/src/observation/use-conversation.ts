import { useCallback, useSyncExternalStore } from 'react';
import { ConversationEntityStore } from './conversation-store';
const empty = new ConversationEntityStore();
export function useConversationWindow(store: ConversationEntityStore | undefined, id: string) {
  const source = store ?? empty;
  return useSyncExternalStore(useCallback(notify => source.subscribe(id, notify), [source, id]),
    useCallback(() => source.window(id), [source, id]));
}
export function useConversationTurn(store: ConversationEntityStore | undefined, id: string, turnId: string) {
  const source = store ?? empty;
  return useSyncExternalStore(useCallback(notify => source.subscribeTurn(id, turnId, notify), [source, id, turnId]),
    useCallback(() => source.turn(id, turnId), [source, id, turnId]));
}
export function useConversationActivity(store: ConversationEntityStore | undefined, id: string) {
  const source = store ?? empty;
  return useSyncExternalStore(useCallback(notify => source.subscribe(`${id}\0activity`, notify), [source, id]),
    useCallback(() => source.activity(id), [source, id]));
}
