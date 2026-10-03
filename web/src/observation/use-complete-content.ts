import { useEffect, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { ConversationContentReference } from '../../../src/session/conversation-read-types';
import type { ConversationEntityStore } from './conversation-store';

const caches = new WeakMap<ConversationEntityStore, Map<string, { text: string; bytes: number }>>();
function cachedBodies(store: ConversationEntityStore) {
  let cache = caches.get(store);
  if (!cache) {
    cache = new Map(); caches.set(store, cache);
    store.onRevoked(id => {
      for (const key of cache!.keys()) if (key.split('\0')[1] === id) cache!.delete(key);
    });
  }
  return cache;
}

/** Range loading is a transport detail: visible messages automatically show their full text. */
export function useCompleteContent(http: HttpClient, store: ConversationEntityStore, conversationId: string,
  reference: ConversationContentReference | null | undefined, preview: string) {
  const [value, setValue] = useState<{ key: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = store.currentGeneration();
  const key = `${generation}\0${conversationId}\0${reference?.hash ?? ''}`;
  const needsBody = Boolean(reference && reference.byteLength > new TextEncoder().encode(preview).length);
  useEffect(() => {
    setError(null);
    if (!reference || !needsBody) { setValue(null); return; }
    const cache = cachedBodies(store);
    if (cache.has(key)) { setValue({ key, text: cache.get(key)!.text }); return; }
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && generation === store.currentGeneration();
    const unsubscribe = store.onRevoked(id => { if (id === conversationId) controller.abort(); });
    void (async () => {
      const parts: string[] = [];
      let offset = 0;
      while (offset < reference.byteLength && current()) {
        const part = await http.getConversationContent(conversationId, reference.hash, offset, controller.signal);
        if (!current()) return;
        const bytes = new TextEncoder().encode(part.text).length;
        if (part.byteLength !== reference.byteLength || part.nextOffset !== offset + bytes || !bytes
          || part.nextOffset > reference.byteLength) throw new Error('结果读取不完整，请重新打开会话。');
        parts.push(part.text); offset = part.nextOffset;
      }
      if (current()) {
        const text = parts.join('');
        // UTF-16 resident strings plus UTF-8 content length, with a count limit.
        const bytes = Math.max(reference.byteLength, text.length * 2);
        if (bytes <= 8 * 1024 * 1024) {
          cache.set(key, { text, bytes });
          let total = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0);
          while (cache.size > 16 || total > 8 * 1024 * 1024) {
            const oldest = cache.keys().next().value!;
            total -= cache.get(oldest)!.bytes; cache.delete(oldest);
          }
        }
        setValue({ key, text });
      }
    })().catch(error => { if (current()) setError((error as Error).message); });
    return () => { controller.abort(); unsubscribe(); };
  }, [key, generation, reference?.byteLength, needsBody, http, store, conversationId]);
  return { text: needsBody ? (value?.key === key ? value.text : cachedBodies(store).get(key)?.text ?? preview) : preview, error };
}
