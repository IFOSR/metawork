import type { ConversationReadModel } from './conversation-read-model.js';
import type { ConversationTurn } from './conversation-store.js';
import { ConversationReadProjector } from './conversation-read-projector.js';

export const CONVERSATION_PROJECTOR_VERSION = 1;

/** Staging is an invisible derivative; publication switches one epoch pointer. */
export interface ConversationReadRebuild {
  readonly view: ConversationReadModel;
  readonly epoch: string;
  readonly historySequence: number;
  readonly historyRevision: string;
}
export interface ConversationReadRebuildStore {
  ensureVersion(accountId: string, conversationId: string): void;
  pending(accountId: string, conversationId: string): ConversationReadRebuild | null;
  begin(accountId: string, conversationId: string): ConversationReadRebuild;
  history(accountId: string, conversationId: string, after: number): { sequence: number; turn: ConversationTurn } | null;
  historyRevision(accountId: string, conversationId: string): string;
  commitHistory(accountId: string, conversationId: string, epoch: string, sequence: number, write: () => void): void;
  publish(accountId: string, conversationId: string, epoch: string, sourceSequence: number): boolean;
  collect(accountId: string, conversationId: string): void;
}

export class ConversationReadRebuilder {
  constructor(private readonly store: ConversationReadRebuildStore,
    private readonly projectJournal: (accountId: string, conversationId: string, view: ConversationReadModel) => Promise<boolean>,
    private readonly sourceSequence: (accountId: string, conversationId: string) => number,
    private readonly projectHistory?: (conversationId: string, epoch: string) => Promise<boolean>) {}

  /** One bounded batch per maintenance tick; a crash leaves the published epoch intact. */
  async maintain(accountId: string, conversationId: string): Promise<boolean> {
    this.store.ensureVersion(accountId, conversationId);
    let staging = this.store.pending(accountId, conversationId);
    if (!staging) { this.store.collect(accountId, conversationId); return true; }
    if (staging.historyRevision !== this.store.historyRevision(accountId, conversationId)) staging = this.store.begin(accountId, conversationId);
    if (this.projectHistory) {
      if (await this.projectHistory(conversationId, staging.epoch)) return false;
    }
    const next = this.projectHistory ? null : this.store.history(accountId, conversationId, staging.historySequence);
    if (next) {
      const projector = new ConversationReadProjector(staging.view);
      this.store.commitHistory(accountId, conversationId, staging.epoch, next.sequence,
        () => projector.applyHistory(accountId, conversationId, next.turn, next.sequence));
      return false;
    }
    if (!await this.projectJournal(accountId, conversationId, staging.view)) return false;
    return this.store.publish(accountId, conversationId, staging.epoch, this.sourceSequence(accountId, conversationId));
  }
}
