import type Database from 'better-sqlite3';
import type {
  EventJournalSegmentIndex, JournalSegment, JournalStreamState, JournalSegmentWrite,
} from '../gateway/event-journal-segment-index.js';
import type { TurnTaskObservation } from '../gateway/turn-task-observation.js';

export class SqliteEventJournalSegmentIndex implements EventJournalSegmentIndex {
  constructor(private readonly db: Database.Database) {}

  nextStream(accountId: string, afterConversationId: string): string | null {
    const row = this.db.prepare(`SELECT conversation_id FROM gateway_journal_streams
      WHERE account_id = ? AND conversation_id > ? ORDER BY conversation_id LIMIT 1`)
      .get(accountId, afterConversationId) as { conversation_id: string } | undefined;
    return row?.conversation_id ?? null;
  }

  read(accountId: string, conversationId: string): JournalStreamState | null {
    const row = this.db.prepare(`SELECT last_sequence, snapshot_json, replay_floor FROM gateway_journal_streams
      WHERE account_id = ? AND conversation_id = ?`).get(accountId, conversationId) as {
        last_sequence: number; snapshot_json: string; replay_floor: number;
      } | undefined;
    return row ? { lastSequence: row.last_sequence, replayFloor: row.replay_floor, snapshot: JSON.parse(row.snapshot_json) } : null;
  }

  readTurnTaskObservation(accountId: string, conversationId: string, turnId: string): TurnTaskObservation | null {
    const row = this.db.prepare(`SELECT observation_json FROM gateway_turn_task_observations
      WHERE account_id = ? AND conversation_id = ? AND turn_id = ?`)
      .get(accountId, conversationId, turnId) as { observation_json: string } | undefined;
    return row ? JSON.parse(row.observation_json) as TurnTaskObservation : null;
  }

  findEvent(accountId: string, conversationId: string, eventId: string): string | null {
    const row = this.db.prepare(`SELECT segment_id FROM gateway_journal_event_index
      WHERE account_id = ? AND conversation_id = ? AND event_id = ?`)
      .get(accountId, conversationId, eventId) as { segment_id: string } | undefined;
    return row?.segment_id ?? null;
  }

  segments(accountId: string, conversationId: string, afterSequence: number, limit = 2_147_483_647): JournalSegment[] {
    return (this.db.prepare(`SELECT segment_id, first_sequence, last_sequence, byte_length FROM gateway_journal_segments
      WHERE account_id = ? AND conversation_id = ? AND last_sequence > ?
      ORDER BY last_sequence LIMIT ?`).all(accountId, conversationId, afterSequence, limit) as {
        segment_id: string; first_sequence: number; last_sequence: number; byte_length: number;
      }[]).map(row => ({
        id: row.segment_id, firstSequence: row.first_sequence, lastSequence: row.last_sequence, byteLength: row.byte_length,
      }));
  }

  hasSegment(accountId: string, conversationId: string, segmentId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM gateway_journal_segments
      WHERE account_id = ? AND conversation_id = ? AND segment_id = ?`)
      .get(accountId, conversationId, segmentId));
  }

  commit(
    accountId: string, conversationId: string, expectedSequence: number | null,
    writes: readonly JournalSegmentWrite[], state: JournalStreamState,
    turnObservations: readonly TurnTaskObservation[],
  ): void {
    this.db.transaction(() => {
      const current = this.read(accountId, conversationId);
      if ((current?.lastSequence ?? null) !== expectedSequence) throw new Error('journal_commit_conflict');
      for (const { segment, events } of writes) {
        this.insertSegment(accountId, conversationId, segment);
        const insert = this.db.prepare(`INSERT INTO gateway_journal_event_index
          (account_id, conversation_id, event_id, sequence, segment_id) VALUES (?, ?, ?, ?, ?)`);
        for (const event of events) insert.run(accountId, conversationId, event.eventId, event.sequence, segment.id);
      }
      if (turnObservations.length) {
        const upsert = this.db.prepare(`INSERT INTO gateway_turn_task_observations
          (account_id, conversation_id, turn_id, observation_json) VALUES (?, ?, ?, ?)
          ON CONFLICT(account_id, conversation_id, turn_id)
          DO UPDATE SET observation_json = excluded.observation_json`);
        for (const observation of turnObservations) {
          upsert.run(accountId, conversationId, observation.turnId, JSON.stringify(observation));
        }
      }
      this.db.prepare(`INSERT INTO gateway_journal_streams (account_id, conversation_id, last_sequence, snapshot_json, replay_floor)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, conversation_id)
        DO UPDATE SET last_sequence = excluded.last_sequence, snapshot_json = excluded.snapshot_json,
          replay_floor = excluded.replay_floor`)
        .run(accountId, conversationId, state.lastSequence, JSON.stringify(state.snapshot), state.replayFloor);
    })();
  }

  replaceSegments(accountId: string, conversationId: string, old: readonly JournalSegment[], next: JournalSegment): void {
    this.db.transaction(() => {
      this.insertSegment(accountId, conversationId, next);
      const update = this.db.prepare(`UPDATE gateway_journal_event_index SET segment_id = ?
        WHERE account_id = ? AND conversation_id = ? AND segment_id = ?`);
      const remove = this.db.prepare(`DELETE FROM gateway_journal_segments
        WHERE account_id = ? AND conversation_id = ? AND segment_id = ?`);
      for (const segment of old) {
        update.run(next.id, accountId, conversationId, segment.id);
        if (remove.run(accountId, conversationId, segment.id).changes !== 1) throw new Error('journal_compaction_conflict');
      }
    })();
  }

  private insertSegment(accountId: string, conversationId: string, segment: JournalSegment): void {
    this.db.prepare(`INSERT INTO gateway_journal_segments
      (account_id, conversation_id, segment_id, first_sequence, last_sequence, byte_length) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(accountId, conversationId, segment.id, segment.firstSequence, segment.lastSequence, segment.byteLength);
  }
}
