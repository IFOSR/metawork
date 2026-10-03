import type { GatewayEventEnvelope, GatewayReplay } from './client-events.js';
import type { TurnTaskObservation } from './turn-task-observation.js';
import type { IndexedTraceEvent } from './trace-read-model.js';
import type { TracePagePosition } from './trace-page-cursor.js';

export interface JournalSegment {
  readonly id: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly byteLength: number;
}

export interface JournalSegmentWrite {
  readonly segment: JournalSegment;
  readonly events: readonly GatewayEventEnvelope[];
  readonly traceEvents?: readonly IndexedTraceEvent[];
}

export interface JournalStreamState {
  readonly lastSequence: number;
  /** Old compaction may have deleted facts at or below this migration boundary. */
  readonly replayFloor: number;
  readonly snapshot: GatewayEventEnvelope[];
}

/** Gateway-owned persistence port. Files become visible only at index commit. */
export interface EventJournalSegmentIndex {
  traceCheckpoint(accountId: string, conversationId: string): number | null;
  indexTraceEvents(accountId: string, conversationId: string, events: readonly IndexedTraceEvent[], through: number): void;
  tracePage(accountId: string, conversationId: string, turnId: string, after: TracePagePosition | null,
    limit: number, maxBytes: number, latest?: boolean): { events: Record<string, unknown>[]; hasMore: boolean };
  nextStream(accountId: string, afterConversationId: string): string | null;
  read(accountId: string, conversationId: string): JournalStreamState | null;
  readTurnTaskObservation(accountId: string, conversationId: string, turnId: string): TurnTaskObservation | null;
  findEvent(accountId: string, conversationId: string, eventId: string): string | null;
  segments(accountId: string, conversationId: string, afterSequence: number, limit?: number): JournalSegment[];
  hasSegment(accountId: string, conversationId: string, segmentId: string): boolean;
  /** Persist Gateway-computed observations atomically; Storage never interprets traces. */
  commit(
    accountId: string, conversationId: string, expectedSequence: number | null,
    writes: readonly JournalSegmentWrite[], state: JournalStreamState,
    turnObservations: readonly TurnTaskObservation[],
  ): void;
  replaceSegments(accountId: string, conversationId: string, old: readonly JournalSegment[], next: JournalSegment): void;
}

export interface ConversationSnapshot extends GatewayReplay {
  readonly snapshotVersion: 1;
}
