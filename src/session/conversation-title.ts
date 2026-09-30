import type { ConversationStore } from './conversation-store.js';
import { updateConversationCatalog } from './conversation-catalog-mutation.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';

export function isDefaultConversationTitle(title: string): boolean {
  return !title.trim() || title === 'New conversation' || title === 'New session';
}

/** A bounded input summary, not a second semantic Planner call. */
export function conversationInputTitle(input: string): string | null {
  const text = input.trim();
  if (!text || text.startsWith('/')) return null;
  return redactSensitiveText(text).replace(/\s+/gu, ' ').slice(0, 80).trimEnd();
}

export async function recordConversationInputTitle(
  store: ConversationStore,
  conversationId: string,
  input: string,
): Promise<void> {
  const title = conversationInputTitle(input);
  if (!title) return;
  const metadata = await store.updateMetadata(conversationId, current => (
    isDefaultConversationTitle(current.title)
      ? { ...current, title, updatedAt: new Date().toISOString() }
      : current
  ));
  if (!metadata) return;
  await updateConversationCatalog(store, catalog => ({
    ...catalog,
    conversations: catalog.conversations.map(item => item.id === conversationId ? metadata : item),
  }));
}
