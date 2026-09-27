/** Application-owned read model. It never authorizes or changes Task lifecycle. */
export interface ConversationHistoryPage<T> {
  /** Chronological within a page; the cursor leads to older turns. */
  readonly turns: T[];
  readonly nextCursor: string | null;
}

export interface ConversationHistoryRequest {
  readonly cursor?: string;
  readonly limit?: number;
  /** Soft byte bound: one oversized Turn is returned for transport fragmentation. */
  readonly maxBytes?: number;
}

export interface ConversationHistoryStore<T extends { readonly id: string }> {
  version(conversationId: string): string | null;
  isImported(conversationId: string): boolean;
  importOnce(conversationId: string, turns: readonly T[]): void;
  upsert(conversationId: string, turn: T): void;
  replace(conversationId: string, turns: readonly T[]): void;
  page(conversationId: string, request: ConversationHistoryRequest): ConversationHistoryPage<T>;
  find(conversationId: string, turnId: string): T | null;
  findMany(conversationId: string, turnIds: readonly string[]): ReadonlyMap<string, T>;
  delete(conversationId: string): boolean;
}
