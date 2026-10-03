import type { ConversationContentReference } from './conversation-read-types.js';

export interface ConversationSearchHit {
  readonly turnId: string;
  readonly excerpt: string;
  readonly content: ConversationContentReference;
  readonly offset: number;
}
export interface ConversationSearchPage {
  readonly hits: readonly ConversationSearchHit[];
  readonly nextCursor: string | null;
  readonly preparing: boolean;
}
/** Search indexes safe, durable content; it never opens an execution session. */
export interface ConversationHistorySearch {
  search(accountId: string, conversationId: string, query: string, cursor?: string): ConversationSearchPage;
}
