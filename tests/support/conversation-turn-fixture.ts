import type Database from 'better-sqlite3';
import { SqliteConversationTurnStore } from '../../src/storage/conversation-turn-repo.js';
export function seedAuthoritativeTurn(db: Database.Database, accountId: string, conversationId: string, view: {
  id: string; userInput: string; answer: string; status: string; startedAt: string; completedAt?: string | null;
  interactionKind?: string; firstSequence: number;
}): void {
  const store = new SqliteConversationTurnStore(db);
  const identity = { accountId, conversationId, turnId: view.id };
  const event = { ...identity, protocolVersion: 2 as const, sequence: 0, requestId: view.id,
    occurredAt: view.startedAt, payload: { interactionKind: view.interactionKind ?? 'ai_turn' } };
  store.accept({ ...identity, userInput: view.userInput, requestKey: view.id,
    event: { ...event, eventId: `start:${view.id}`, kind: 'turn_started' } });
  store.appendFinalAnswer({ ...identity, content: view.answer, revisionKey: 'fixture',
    event: { ...event, eventId: `end:${view.id}`, kind: 'final_answer', occurredAt: view.completedAt ?? view.startedAt } });
  db.prepare(`UPDATE conversation_turns SET sequence = ? WHERE account_id = ? AND conversation_id = ? AND turn_id = ?`)
    .run(view.firstSequence, accountId, conversationId, view.id);
  db.prepare(`UPDATE conversation_history_turns SET body_json = json_set(body_json, '$.status', ?)
    WHERE account_id = ? AND conversation_id = ? AND turn_id = ? AND kind = 'conversation'`)
    .run(view.status, accountId, conversationId, view.id);
}
