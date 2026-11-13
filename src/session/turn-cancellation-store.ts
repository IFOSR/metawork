/** Conversation-owned admission fence. This does not settle Task cancellation. */
export interface TurnCancellationStore {
  request(conversationId: string, turnId: string, occurredAt: string): void;
  isRequested(conversationId: string, turnId: string): boolean;
}
