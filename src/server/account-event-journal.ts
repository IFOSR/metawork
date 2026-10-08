import { SqliteConversationHistorySearch } from '../storage/conversation-history-search-repo.js';
import type Database from 'better-sqlite3';
import { FileEventJournal } from '../gateway/file-event-journal.js';
import { SegmentedEventJournal } from '../gateway/segmented-event-journal.js';
import { EventJournalMaintenance } from '../gateway/event-journal-maintenance.js';
import { SqliteEventJournalSegmentIndex } from '../storage/event-journal-segment-index-repo.js';
import { SqliteConversationReadModel } from '../storage/conversation-read-model-repo.js';
import { SqliteConversationHistoryProjectionSource } from '../storage/conversation-history-projection-source.js';
import { ConversationReadProjector } from '../session/conversation-read-projector.js';
import { ConversationReadRebuilder } from '../session/conversation-read-rebuild.js';
import { SqliteConversationReadRebuildStore } from '../storage/conversation-read-rebuild-repo.js';
import type { ConversationReadModel } from '../session/conversation-read-model.js';
import { ConversationHistoryWorkerClient } from './conversation-history-worker-client.js';
import type { WindowsPrivateFileRoot } from '../platform/windows-private-files.js';

/** The legacy adapter is a read-only migration source, never a parallel writer. */
export function createAccountEventJournal(input: {
  db: Database.Database;
  root: string;
  accountId: string;
  onError: (error: unknown) => void;
  readModel?: ConversationReadModel;
  /** Legacy import is maintenance work, never part of an observation request. */
  prepareHistory?: (conversationId: string) => Promise<void>;
  historyWorkerUrl?: URL;
  windows?: WindowsPrivateFileRoot;
}) {
  const index = new SqliteEventJournalSegmentIndex(input.db);
  const readModel = input.readModel ?? new SqliteConversationReadModel(input.db);
  const search = new SqliteConversationHistorySearch(input.db, readModel);
  const history = new SqliteConversationHistoryProjectionSource(input.db);
  const historyWorker = input.historyWorkerUrl
    ? new ConversationHistoryWorkerClient(input.historyWorkerUrl, input.db.name, input.accountId) : null;
  const projector = new ConversationReadProjector(readModel);
  const journal = new SegmentedEventJournal(input.root, index, new FileEventJournal(input.root), readModel, input.onError, input.windows);
  const rebuilds = new SqliteConversationReadRebuildStore(input.db);
  const rebuilder = new ConversationReadRebuilder(rebuilds,
    (accountId, conversationId, view) => journal.projectReadBatch(accountId, conversationId, view),
    (accountId, conversationId) => index.headSequence(accountId, conversationId) ?? 0,
    historyWorker ? (conversationId, epoch) => historyWorker.run(conversationId, epoch) : undefined);
  const maintenance = new EventJournalMaintenance({
    accountId: input.accountId,
    nextStream: (accountId, after) => index.nextStream(accountId, after),
    intervalMs: 25,
    maintain: async (accountId, conversationId) => {
      await input.prepareHistory?.(conversationId);
      const started = performance.now();
      if (historyWorker) await historyWorker.run(conversationId);
      for (let n = 0; !historyWorker && n < 16 && performance.now() - started < 20; n++) {
        if (history.primeRecent(accountId, conversationId,
          (turn, sequence) => projector.applyHistory(accountId, conversationId, turn, sequence))) continue;
        if (history.drainDirty(accountId, conversationId,
          (turn, sequence) => projector.applyHistory(accountId, conversationId, turn, sequence),
          turnId => readModel.remove(accountId, conversationId, turnId))) continue;
        const next = history.next(accountId, conversationId);
        if (!next) break;
        history.commit(accountId, conversationId, next.sequence,
          () => projector.applyHistory(accountId, conversationId, next.turn, next.sequence));
      }
      const done = await journal.maintain(accountId, conversationId);
      const rebuilt = await rebuilder.maintain(accountId, conversationId);
      const indexed = search.maintain(accountId, conversationId);
      return done && rebuilt && !indexed && !history.hasPending(accountId, conversationId);
    },
    onError: input.onError,
  });
  return {
    journal,
    readModel,
    search,
    rebuild: (accountId: string, conversationId: string) => rebuilds.begin(accountId, conversationId),
    sourceSequence: (accountId: string, conversationId: string) => rebuilds.pending(accountId, conversationId) || history.hasPending(accountId, conversationId)
      ? null : index.headSequence(accountId, conversationId),
    start: () => maintenance.start(),
    async stop() {
      await maintenance.stop();
      await historyWorker?.close();
      await journal.close();
    },
  };
}
