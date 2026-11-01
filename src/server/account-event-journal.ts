import { SqliteConversationTurnMigration } from '../storage/conversation-turn-migration.js';
import { SqliteConversationTurnStore } from '../storage/conversation-turn-repo.js';
import { SqliteConversationHistorySearch } from '../storage/conversation-history-search-repo.js';
import type Database from 'better-sqlite3';
import { FileEventJournal } from '../gateway/file-event-journal.js';
import { SegmentedEventJournal } from '../gateway/segmented-event-journal.js';
import {
  EventJournalMaintenance,
  type JournalMaintenanceErrorContext,
  type JournalMaintenanceRecoveryContext,
} from '../gateway/event-journal-maintenance.js';
import { SqliteEventJournalSegmentIndex } from '../storage/event-journal-segment-index-repo.js';
import { SqliteConversationReadModel } from '../storage/conversation-read-model-repo.js';
import { SqliteConversationHistoryProjectionSource } from '../storage/conversation-history-projection-source.js';
import { ConversationReadProjector } from '../session/conversation-read-projector.js';
import { ConversationReadRebuilder } from '../session/conversation-read-rebuild.js';
import { SqliteConversationReadRebuildStore } from '../storage/conversation-read-rebuild-repo.js';
import type { ConversationReadModel } from '../session/conversation-read-model.js';
import { ConversationHistoryWorkerClient } from './conversation-history-worker-client.js';

/** The legacy adapter is a read-only migration source, never a parallel writer. */
export function createAccountEventJournal(input: {
  db: Database.Database;
  root: string;
  accountId: string;
  /** The context carries the Conversation and stage the stack alone cannot name. */
  onError: (error: unknown, context?: JournalMaintenanceErrorContext) => void;
  onRecovered?: (context: JournalMaintenanceRecoveryContext) => void;
  readModel?: ConversationReadModel;
  /** Legacy import is maintenance work, never part of an observation request. */
  prepareHistory?: (conversationId: string) => Promise<void>;
  retireLegacyFiles?: (conversationId: string) => Promise<void>;
  historyWorkerUrl?: URL;
}) {
  const index = new SqliteEventJournalSegmentIndex(input.db);
  const readModel = input.readModel ?? new SqliteConversationReadModel(input.db);
  const search = new SqliteConversationHistorySearch(input.db, readModel);
  const history = new SqliteConversationHistoryProjectionSource(input.db);
  const historyWorker = input.historyWorkerUrl
    ? new ConversationHistoryWorkerClient(input.historyWorkerUrl, input.db.name, input.accountId) : null;
  const projector = new ConversationReadProjector(readModel);
  const journal = new SegmentedEventJournal(input.root, index, new FileEventJournal(input.root), readModel, input.onError);
  const rebuilds = new SqliteConversationReadRebuildStore(input.db);
  const rebuilder = new ConversationReadRebuilder(rebuilds,
    (accountId, conversationId, view) => journal.projectReadBatch(accountId, conversationId, view),
    (accountId, conversationId) => index.headSequence(accountId, conversationId) ?? 0,
    historyWorker ? (conversationId, epoch) => historyWorker.run(conversationId, epoch) : undefined);
  /** The single bounded maintenance pass shared by the loop and diagnostics. */
  const maintain = async (accountId: string, conversationId: string) => {
    if (new SqliteConversationTurnStore(input.db).deletionState(accountId, conversationId)) return { done: true, didWork: false };
    await input.prepareHistory?.(conversationId);
    // Legacy provenance is assessed once per unchanged stream, off the client
    // request path. Unresolved bytes remain legacy-only and never enter Memory.
    const legacy = input.db.prepare(`SELECT 1 FROM conversation_history_turns h WHERE h.account_id = ?
      AND h.conversation_id = ? AND h.kind = 'conversation'
      AND NOT EXISTS (SELECT 1 FROM conversation_turns t WHERE t.account_id = h.account_id
        AND t.conversation_id = h.conversation_id AND t.turn_id = h.turn_id)
      AND NOT EXISTS (SELECT 1 FROM conversation_turn_migration m WHERE m.account_id = h.account_id
        AND m.conversation_id = h.conversation_id AND m.turn_id = h.turn_id) LIMIT 1`).get(accountId, conversationId);
    if (legacy) {
      const replay = await journal.replay(accountId, conversationId);
      const migration = new SqliteConversationTurnMigration(input.db);
      const events = [...replay.snapshot, ...replay.deltas];
      migration.review(accountId, conversationId, events);
      migration.migrate(accountId, conversationId, events);
    }
    const migration = new SqliteConversationTurnMigration(input.db);
    if (input.retireLegacyFiles && migration.canRetire(accountId, conversationId)) {
      await input.retireLegacyFiles(conversationId);
      migration.retireCopies(accountId, conversationId);
    }
    const started = performance.now();
    let historyWorked = false;
    if (historyWorker) historyWorked = await historyWorker.run(conversationId);
    for (let n = 0; !historyWorker && n < 16 && performance.now() - started < 20; n++) {
      if (history.primeRecent(accountId, conversationId,
        (turn, sequence) => projector.applyHistory(accountId, conversationId, turn, sequence))) {
        historyWorked = true;
        continue;
      }
      if (history.drainDirty(accountId, conversationId,
        (turn, sequence) => projector.applyHistory(accountId, conversationId, turn, sequence),
        turnId => readModel.remove(accountId, conversationId, turnId))) {
        historyWorked = true;
        continue;
      }
      const next = history.next(accountId, conversationId);
      if (!next) break;
      history.commit(accountId, conversationId, next.sequence,
        () => projector.applyHistory(accountId, conversationId, next.turn, next.sequence));
      historyWorked = true;
    }
    const journalPass = await journal.maintain(accountId, conversationId);
    const rebuiltDone = await rebuilder.maintain(accountId, conversationId);
    // `search.maintain` returns true only when it consumed a queued chunk.
    const indexed = search.maintain(accountId, conversationId);
    const pending = history.hasPending(accountId, conversationId);
    const done = journalPass.done && rebuiltDone && !indexed && !pending;
    return {
      done,
      didWork: journalPass.didWork || !done || historyWorked || indexed,
    };
  };
  const maintenance = new EventJournalMaintenance({
    accountId: input.accountId,
    nextStream: (accountId, after) => index.nextStream(accountId, after),
    // Active work keeps the small batch rate; a converged sweep sleeps.
    intervalMs: 25,
    idleIntervalMs: 1_000,
    maintain,
    // The lower-level maintenance object exposes suppressed failures to its
    // callers, but production logging must only receive report-worthy ones.
    onError: (error, context) => {
      if (context.outcome === 'suppressed') return;
      input.onError(error, context);
    },
    onRecovered: input.onRecovered,
  });
  return {
    journal,
    readModel,
    search,
    rebuild: (accountId: string, conversationId: string) => rebuilds.begin(accountId, conversationId),
    sourceSequence: (accountId: string, conversationId: string) => rebuilds.pending(accountId, conversationId) || history.hasPending(accountId, conversationId)
      ? null : index.headSequence(accountId, conversationId),
    start: () => maintenance.start(),
    /** Publish-and-wake seams call this when a stream gains work while idle. */
    wake: () => maintenance.wake(),
    /** One deterministic pass, the same unit the background loop runs. */
    maintainOnce: maintain,
    async stop() {
      await maintenance.stop();
      await historyWorker?.close();
      await journal.close();
    },
  };
}
