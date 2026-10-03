import type { Task } from '../core/types.js';

export type ConversationActivityTask = Pick<Task, 'id' | 'title' | 'status' | 'updatedAt'>;

export interface ConversationActivitySource {
  page(accountId: string, conversationId: string, cursor?: string, limit?: number): {
    readonly tasks: readonly ConversationActivityTask[]; readonly nextCursor: string | null;
  };
}
