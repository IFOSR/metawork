import type { GatewayEventEnvelope } from '../gateway/client-events.js';

export interface TurnIdentity {
  accountId: string;
  conversationId: string;
  turnId: string;
}
export interface TurnBodyReference { hash: string; byteLength: number }
export interface StoredConversationTurn extends TurnIdentity {
  sequence: number;
  input: TurnBodyReference;
  answer: TurnBodyReference | null;
  answerRevision: number | null;
  createdAt: string;
}

/** Conversation content authority. Task lifecycle and semantic decisions are separate. */
export interface ConversationTurnStore {
  accept(input: TurnIdentity & { userInput: string; requestKey: string; event: GatewayEventEnvelope }): StoredConversationTurn;
  appendFinalAnswer(input: TurnIdentity & { content: string; revisionKey: string; sourceTaskId?: string | null;
    event: GatewayEventEnvelope }): StoredConversationTurn;
  recordFailure(identity: TurnIdentity, occurredAt: string): void;
  find(identity: TurnIdentity): StoredConversationTurn | null;
  findRequest(accountId: string, conversationId: string, requestKey: string): StoredConversationTurn | null;
  readBody(accountId: string, hash: string): TurnBodyReference & { text: string };
  pendingEvents(accountId: string, limit?: number): GatewayEventEnvelope[];
  acknowledgeEvent(accountId: string, eventId: string): void;
  deletionState(accountId: string, conversationId: string): 'pending' | 'completed' | null;
}
