import type Database from 'better-sqlite3';
import { FileEventJournal } from '../gateway/file-event-journal.js';
import { SegmentedEventJournal } from '../gateway/segmented-event-journal.js';
import { EventJournalMaintenance } from '../gateway/event-journal-maintenance.js';
import { SqliteEventJournalSegmentIndex } from '../storage/event-journal-segment-index-repo.js';

/** The legacy adapter is a read-only migration source, never a parallel writer. */
export function createAccountEventJournal(input: {
  db: Database.Database;
  root: string;
  accountId: string;
  onError: (error: unknown) => void;
}) {
  const index = new SqliteEventJournalSegmentIndex(input.db);
  const journal = new SegmentedEventJournal(input.root, index, new FileEventJournal(input.root));
  const maintenance = new EventJournalMaintenance({
    accountId: input.accountId,
    nextStream: (accountId, after) => index.nextStream(accountId, after),
    maintain: (accountId, conversationId) => journal.maintain(accountId, conversationId),
    onError: input.onError,
  });
  return {
    journal,
    start: () => maintenance.start(),
    async stop() {
      await maintenance.stop();
      await journal.close();
    },
  };
}
