/** Durable deletion is independent of directory archival and is retryable. */
export interface ConversationDeletionPort {
  begin(accountId: string, conversationId: string): void;
  cleanLocal(accountId: string, conversationId: string): void;
  complete(accountId: string, conversationId: string): void;
  pending(accountId: string): string[];
}

export class ConversationDeletionService {
  private readonly operations = new Map<string, Promise<'completed' | 'pending'>>();
  constructor(private readonly deps: {
    store: ConversationDeletionPort;
    cleanFiles: (accountId: string, conversationId: string) => Promise<void>;
    cleanMemory: (accountId: string, conversationId: string) => Promise<boolean>;
    onError: (error: unknown) => void;
  }) {}

  remove(accountId: string, conversationId: string): Promise<'completed' | 'pending'> {
    const key = `${accountId}:${conversationId}`;
    const running = this.operations.get(key);
    if (running) return running;
    this.deps.store.begin(accountId, conversationId);
    const work = this.run(accountId, conversationId).finally(() => this.operations.delete(key));
    this.operations.set(key, work);
    return work;
  }

  async retry(accountId: string): Promise<void> {
    for (const conversationId of this.deps.store.pending(accountId)) await this.remove(accountId, conversationId);
  }

  private async run(accountId: string, conversationId: string): Promise<'completed' | 'pending'> {
    try {
      await this.deps.cleanFiles(accountId, conversationId);
      this.deps.store.cleanLocal(accountId, conversationId);
      if (!await this.deps.cleanMemory(accountId, conversationId)) return 'pending';
      this.deps.store.complete(accountId, conversationId);
      return 'completed';
    } catch (error) {
      this.deps.onError(error);
      return 'pending';
    }
  }
}
