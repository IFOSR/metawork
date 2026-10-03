import type Database from 'better-sqlite3';
import type {
  EventJournalSegmentIndex, JournalSegment, JournalStreamState, JournalSegmentWrite,
} from '../gateway/event-journal-segment-index.js';
import type { TurnTaskObservation } from '../gateway/turn-task-observation.js';
import type { IndexedTraceEvent } from '../gateway/trace-read-model.js';
import type { TracePagePosition } from '../gateway/trace-page-cursor.js';

export class SqliteEventJournalSegmentIndex implements EventJournalSegmentIndex {
  constructor(private readonly db: Database.Database) {}

  headSequence(accountId: string, conversationId: string): number | null {
    const row = this.db.prepare(`SELECT last_sequence FROM gateway_journal_streams
      WHERE account_id = ? AND conversation_id = ?`).get(accountId, conversationId) as { last_sequence: number } | undefined;
    return row?.last_sequence ?? null;
  }

  traceCheckpoint(accountId: string, conversationId: string): number | null {
    const row = this.db.prepare(`SELECT indexed_through FROM gateway_trace_read_heads
      WHERE account_id = ? AND conversation_id = ?`).get(accountId, conversationId) as
      { indexed_through: number } | undefined;
    return row?.indexed_through ?? null;
  }

  indexTraceEvents(accountId: string, conversationId: string, events: readonly IndexedTraceEvent[], through: number): void {
    this.db.transaction(() => {
      this.writeTraceEvents(accountId, conversationId, events);
      this.db.prepare(`INSERT INTO gateway_trace_read_heads (account_id, conversation_id, indexed_through)
        VALUES (?, ?, ?) ON CONFLICT(account_id, conversation_id)
        DO UPDATE SET indexed_through = MAX(indexed_through, excluded.indexed_through)`)
        .run(accountId, conversationId, through);
    }).immediate();
  }

  tracePage(accountId: string, conversationId: string, turnId: string, after: TracePagePosition | null,
    limit: number, maxBytes: number, latest = false): { events: Record<string, unknown>[]; hasMore: boolean } {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT event_id, byte_length FROM gateway_trace_read_events
        WHERE account_id = ? AND conversation_id = ? AND turn_id = ?
          AND (sequence, event_key, event_id) > (?, ?, ?)
        ORDER BY sequence ${latest ? 'DESC' : 'ASC'}, event_key ${latest ? 'DESC' : 'ASC'}, event_id ${latest ? 'DESC' : 'ASC'} LIMIT ?`).all(accountId, conversationId, turnId,
        after?.sequence ?? -1, after?.eventKey ?? '', after?.eventId ?? after?.eventKey ?? '', limit + 1) as
        Array<{ event_id: string; byte_length: number }>;
      let bytes = 2;
      const events: Record<string, unknown>[] = [];
      const read = this.db.prepare(`SELECT body_json FROM gateway_trace_read_events
        WHERE account_id = ? AND conversation_id = ? AND turn_id = ? AND event_id = ?`);
      for (const row of rows.slice(0, limit)) {
        if (bytes + row.byte_length + 1 > maxBytes) {
          if (!events.length) throw new Error('trace_page_budget_too_small');
          break;
        }
        const value = read.get(accountId, conversationId, turnId, row.event_id) as { body_json: string };
        events.push(JSON.parse(value.body_json) as Record<string, unknown>);
        bytes += row.byte_length + 1;
      }
      return { events: latest ? events.reverse() : events, hasMore: !latest && rows.length > events.length };
    }).deferred();
  }

  private writeTraceEvents(accountId: string, conversationId: string, events: readonly IndexedTraceEvent[]): void {
    const write = this.db.prepare(`INSERT INTO gateway_trace_read_events
      (account_id, conversation_id, turn_id, event_id, gateway_sequence, sequence, event_key, body_json, byte_length)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, conversation_id, turn_id, event_id) DO UPDATE SET
        gateway_sequence = excluded.gateway_sequence, sequence = excluded.sequence,
        event_key = excluded.event_key, body_json = excluded.body_json, byte_length = excluded.byte_length
      WHERE excluded.gateway_sequence >= gateway_trace_read_events.gateway_sequence`);
    for (const event of events) {
      const body = JSON.stringify(event.value);
      write.run(accountId, conversationId, event.turnId, event.eventId, event.gatewaySequence,
        event.position.sequence, event.position.eventKey, body, Buffer.byteLength(body));
    }
  }

  nextStream(accountId: string, afterConversationId: string): string | null {
    const row = this.db.prepare(`SELECT conversation_id FROM gateway_journal_streams
      WHERE account_id = ? AND conversation_id > ?
      UNION SELECT conversation_id FROM conversation_history_streams
      WHERE account_id = ? AND kind = 'conversation' AND conversation_id > ?
      UNION SELECT conversation_id FROM conversation_read_rebuilds
      WHERE account_id = ? AND conversation_id > ?
      UNION SELECT conversation_id FROM conversation_read_heads
      WHERE account_id = ? AND conversation_id > ?
      UNION SELECT conversation_id FROM conversation_read_history_dirty
      WHERE account_id = ? AND conversation_id > ?
      UNION SELECT conversation_id FROM conversation_metadata_projection
      WHERE account_id = ? AND conversation_id > ?
      ORDER BY conversation_id LIMIT 1`)
      .get(accountId, afterConversationId, accountId, afterConversationId, accountId, afterConversationId, accountId, afterConversationId,
        accountId, afterConversationId, accountId, afterConversationId) as { conversation_id: string } | undefined;
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
      const traceCheckpoint = this.traceCheckpoint(accountId, conversationId);
      const traceEvents = writes.flatMap(write => write.traceEvents ?? []);
      this.writeTraceEvents(accountId, conversationId, traceEvents);
      // Old streams rebuild in background. Fresh writes never skip their backlog.
      if (!current || traceCheckpoint === current.lastSequence) {
        this.indexTraceEvents(accountId, conversationId, [], state.lastSequence);
      }
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
    }).immediate();
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
    }).immediate();
  }

  private insertSegment(accountId: string, conversationId: string, segment: JournalSegment): void {
    this.db.prepare(`INSERT INTO gateway_journal_segments
      (account_id, conversation_id, segment_id, first_sequence, last_sequence, byte_length) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(accountId, conversationId, segment.id, segment.firstSequence, segment.lastSequence, segment.byteLength);
  }
}
