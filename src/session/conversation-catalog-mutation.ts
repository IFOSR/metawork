import type { ConversationCatalogFile, ConversationStore } from './conversation-store.js';

const pendingMutations = new WeakMap<ConversationStore, Promise<void>>();

/** All writers sharing the account store must serialize the read/modify/write. */
export async function updateConversationCatalog(
  store: ConversationStore,
  update: (catalog: ConversationCatalogFile) => ConversationCatalogFile,
): Promise<void> {
  const previous = pendingMutations.get(store) ?? Promise.resolve();
  const next = previous.then(async () => {
    const catalog = await store.readCatalog();
    await store.writeCatalog(update(catalog));
  });
  const tail = next.catch(() => undefined);
  pendingMutations.set(store, tail);
  try {
    await next;
  } finally {
    if (pendingMutations.get(store) === tail) pendingMutations.delete(store);
  }
}
