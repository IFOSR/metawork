import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { SqliteConversationHistoryProjectionSource } from '../storage/conversation-history-projection-source.js';
import { createConversationReadModel } from './conversation-read-model-composition.js';
import { SqliteConversationReadRebuildStore } from '../storage/conversation-read-rebuild-repo.js';
import { ConversationReadProjector } from '../session/conversation-read-projector.js';

// Composition only: reuse the canonical projector and Storage ports. Parsing a
// legacy monolithic Turn must not occupy the Server's request/event loop.
const { database, accountId } = workerData as { database: string; accountId: string };
const db = new Database(database);
db.pragma('busy_timeout = 1000');
const source = new SqliteConversationHistoryProjectionSource(db);
const model = createConversationReadModel(db);
const projector = new ConversationReadProjector(model);
const rebuilds = new SqliteConversationReadRebuildStore(db);
parentPort!.on('message', (job: { conversationId: string; epoch?: string }) => {
  try {
    const { conversationId, epoch } = job;
    if (epoch) {
      const progressed = db.transaction(() => {
        const staging = rebuilds.pending(accountId, conversationId);
        if (!staging || staging.epoch !== epoch) throw new Error('observation_stale_rebuild');
        const next = rebuilds.history(accountId, conversationId, staging.historySequence);
        if (!next) return false;
        rebuilds.commitHistory(accountId, conversationId, epoch, next.sequence,
          () => new ConversationReadProjector(staging.view).applyHistory(accountId, conversationId, next.turn, next.sequence));
        return true;
      }).immediate();
      parentPort!.postMessage({ progressed });
      return;
    }
    if (!source.hasPending(accountId, conversationId)) {
      parentPort!.postMessage({ progressed: false });
      return;
    }
    const started = performance.now();
    for (let n = 0; n < 16 && performance.now() - started < 20; n++) {
      const progressed = db.transaction(() => {
        if (source.primeRecent(accountId, conversationId,
          (turn, sequence) => projector.applyHistory(accountId, conversationId, turn, sequence))) return true;
        if (source.drainDirty(accountId, conversationId,
          (turn, sequence) => projector.applyHistory(accountId, conversationId, turn, sequence),
          turnId => model.remove(accountId, conversationId, turnId))) return true;
        const next = source.next(accountId, conversationId);
        if (!next) return false;
        source.commit(accountId, conversationId, next.sequence,
          () => projector.applyHistory(accountId, conversationId, next.turn, next.sequence));
        return true;
      }).immediate();
      if (!progressed) break;
    }
    parentPort!.postMessage({ progressed: source.hasPending(accountId, conversationId) });
  } catch (error) {
    parentPort!.postMessage({ error: (error as Error).message });
  }
});
