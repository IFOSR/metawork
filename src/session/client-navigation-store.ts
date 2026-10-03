/** A client's selection is a preference, never Conversation ownership or execution authority. */
export interface ClientNavigationKey {
  accountId: string;
  principalId: string;
  platform: string;
  channelId: string;
  threadId?: string;
}
export interface ClientNavigationSelection extends ClientNavigationKey {
  workspaceId: string | null;
  conversationId: string | null;
}
export interface ClientNavigationStore {
  read(key: ClientNavigationKey): ClientNavigationSelection | null;
  write(value: ClientNavigationSelection): void;
}
