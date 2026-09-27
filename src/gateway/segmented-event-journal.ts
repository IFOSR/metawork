import { randomUUID } from 'node:crypto';
import { mkdir, open, opendir, readFile, rename, unlink } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { resolve } from 'node:path';
import { isValidAccountId } from '../account/account-id.js';
import { isValidConversationId } from '../session/conversation-types.js';
import type { EventJournal } from './event-journal.js';
import type { EventJournalSegmentIndex, JournalSegment, JournalStreamState, ConversationSnapshot, JournalSegmentWrite } from './event-journal-segment-index.js';
import {
  gatewayEventPayloadBytes, MAX_GATEWAY_EVENT_PAYLOAD_BYTES, sanitizeGatewayEventPayload,
  type GatewayEventEnvelope, type GatewayReplay,
} from './client-events.js';
import { projectConversationSnapshot } from './conversation-snapshot-store.js';
import {
  observeTurnTaskTrace, traceObservationTurnIds, type TurnTaskObservation,
} from './turn-task-observation.js';

const operations = new Map<string, Promise<unknown>>();
export const MAX_JOURNAL_SEGMENT_BYTES = 256 * 1024;
export const MAX_JOURNAL_RESUME_BYTES = 256 * 1024;
const MAINTENANCE_SEGMENTS = 16;
const MAINTENANCE_FILES = 64;

/** Segment bodies are immutable; the transactional index is their commit point. */
export class SegmentedEventJournal implements EventJournal {
  private readonly compactionCursors = new Map<string, number>();
  private readonly cleanupDirectories = new Map<string, Dir>();

  constructor(
    private readonly root: string,
    private readonly index: EventJournalSegmentIndex,
    private readonly legacy: Required<Pick<EventJournal, 'exportRetained'>>,
  ) {}

  append(event: GatewayEventEnvelope): Promise<GatewayEventEnvelope> {
    return this.appendBatch([event]).then(events => events[0]!);
  }

  async appendBatch(events: GatewayEventEnvelope[]): Promise<GatewayEventEnvelope[]> {
    if (!events.length) return [];
    const first = events[0]!;
    for (const event of events) {
      if (event.protocolVersion !== 2 || event.accountId !== first.accountId
        || event.conversationId !== first.conversationId) throw new Error('Invalid Gateway event batch');
      if (gatewayEventPayloadBytes(event.payload) > MAX_GATEWAY_EVENT_PAYLOAD_BYTES) throw new Error('Gateway event payload exceeds limit');
    }
    return this.serialized(first.accountId, first.conversationId, async () => {
      const state = await this.ensureStream(first.accountId, first.conversationId);
      let sequence = state.lastSequence;
      const fresh: GatewayEventEnvelope[] = [];
      const result: GatewayEventEnvelope[] = [];
      const byId = new Map<string, GatewayEventEnvelope>();
      for (const event of events) {
        const segmentId = this.index.findEvent(event.accountId, event.conversationId, event.eventId);
        const existing = byId.get(event.eventId) ?? (segmentId
          ? (await this.readSegment(event.accountId, event.conversationId, segmentId)).find(item => item.eventId === event.eventId)
          : null);
        if (segmentId && !existing) throw new Error('journal_index_corrupt');
        if (existing) { result.push(existing); continue; }
        const stored = { ...event, sequence: ++sequence, payload: sanitizeGatewayEventPayload(event.payload) };
        if (gatewayEventPayloadBytes(stored.payload) > MAX_GATEWAY_EVENT_PAYLOAD_BYTES) throw new Error('Gateway event payload exceeds limit');
        byId.set(stored.eventId, stored);
        fresh.push(stored);
        result.push(stored);
      }
      if (!fresh.length) return result;
      const writes = await this.writeSegments(first.accountId, first.conversationId, fresh);
      this.index.commit(first.accountId, first.conversationId, state.lastSequence, writes, {
        lastSequence: sequence, replayFloor: state.replayFloor, snapshot: projectConversationSnapshot(state.snapshot, fresh),
      }, this.projectTurnObservations(first.accountId, first.conversationId, fresh));
      return result;
    });
  }

  snapshot(accountId: string, conversationId: string): Promise<ConversationSnapshot> {
    return this.serialized(accountId, conversationId, async () => {
      const state = await this.ensureStream(accountId, conversationId);
      return { ...state, snapshotVersion: 1, deltas: [] };
    });
  }

  readTurnTaskObservation(accountId: string, conversationId: string, turnId: string): Promise<{
    lastSequence: number; observation: TurnTaskObservation | null;
  }> {
    return this.serialized(accountId, conversationId, async () => {
      const state = await this.ensureStream(accountId, conversationId);
      return {
        lastSequence: state.lastSequence,
        observation: this.index.readTurnTaskObservation(accountId, conversationId, turnId),
      };
    });
  }

  replay(accountId: string, conversationId: string, afterSequence = 0): Promise<GatewayReplay> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) return Promise.reject(new Error('invalid_journal_cursor'));
    return this.serialized(accountId, conversationId, async () => {
      const state = await this.ensureStream(accountId, conversationId);
      const deltas: GatewayEventEnvelope[] = [];
      for (const segment of this.index.segments(accountId, conversationId, afterSequence)) {
        deltas.push(...(await this.readSegment(accountId, conversationId, segment.id))
          .filter(event => event.sequence > afterSequence));
      }
      return { lastSequence: state.lastSequence, snapshot: state.snapshot, deltas };
    });
  }

  resume(accountId: string, conversationId: string, afterSequence: number): Promise<GatewayReplay> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) return Promise.reject(new Error('invalid_journal_cursor'));
    return this.serialized(accountId, conversationId, async () => {
      const state = await this.ensureStream(accountId, conversationId);
      const reset = (reason: NonNullable<GatewayReplay['cursorReset']>['reason']): GatewayReplay => ({
        ...state, deltas: [], cursorReset: { reason, sequence: state.lastSequence },
      });
      if (afterSequence > state.lastSequence) return reset('cursor_ahead');
      if (afterSequence < state.replayFloor) return reset('cursor_expired');
      const segments = this.index.segments(accountId, conversationId, afterSequence, MAINTENANCE_SEGMENTS + 1);
      if (segments.length > MAINTENANCE_SEGMENTS) return reset('replay_budget_exceeded');
      // Inspect metadata before opening any body. Reconnect never scans an audit.
      if (segments.reduce((bytes, segment) => bytes + segment.byteLength, 0) > MAX_JOURNAL_RESUME_BYTES) {
        return reset('replay_budget_exceeded');
      }
      const deltas: GatewayEventEnvelope[] = [];
      for (const segment of segments) {
        deltas.push(...(await this.readSegment(accountId, conversationId, segment.id))
          .filter(event => event.sequence > afterSequence));
      }
      return { ...state, deltas };
    });
  }

  lastSequence(accountId: string, conversationId: string): Promise<number> {
    return this.serialized(accountId, conversationId, async () => (await this.ensureStream(accountId, conversationId)).lastSequence);
  }

  reserveSequence(accountId: string, conversationId: string): Promise<number> {
    return this.serialized(accountId, conversationId, async () => {
      const state = await this.ensureStream(accountId, conversationId);
      this.index.commit(accountId, conversationId, state.lastSequence, [], {
        ...state, lastSequence: state.lastSequence + 1,
      }, []);
      return state.lastSequence + 1;
    });
  }

  /** Bounded maintenance batch; index switch precedes removal of old bodies. */
  compact(accountId: string, conversationId: string): Promise<void> {
    return this.serialized(accountId, conversationId, async () => {
      await this.ensureStream(accountId, conversationId);
      await this.compactBatch(accountId, conversationId);
    });
  }

  /** One maintenance pass bounds both metadata/body work and directory entries. */
  maintain(accountId: string, conversationId: string): Promise<boolean> {
    return this.serialized(accountId, conversationId, async () => {
      await this.ensureStream(accountId, conversationId);
      await this.compactBatch(accountId, conversationId);
      await this.cleanupOrphans(accountId, conversationId);
      return !this.cleanupDirectories.has(this.directory(accountId, conversationId));
    });
  }

  async close(): Promise<void> {
    // The owner stops the maintenance timer before closing the journal.
    await Promise.all([...operations.entries()]
      .filter(([key]) => key.startsWith(`${resolve(this.root)}/`)).map(([, pending]) => pending.catch(() => undefined)));
    for (const directory of this.cleanupDirectories.values()) await directory.close();
    this.cleanupDirectories.clear();
  }

  private async compactBatch(accountId: string, conversationId: string): Promise<void> {
      const key = this.directory(accountId, conversationId);
      const cursor = this.compactionCursors.get(key) ?? 0;
      const candidates = this.index.segments(accountId, conversationId, cursor, MAINTENANCE_SEGMENTS);
      this.compactionCursors.set(key, candidates.length === MAINTENANCE_SEGMENTS
        ? candidates.at(-1)!.lastSequence : 0);
      let segments: JournalSegment[] = [];
      let bytes = 2;
      for (const segment of candidates) {
        const additional = segment.byteLength - 2 + (segments.length ? 1 : 0);
        if (bytes + additional > MAX_JOURNAL_SEGMENT_BYTES) {
          if (segments.length >= 2) break;
          segments = [];
          bytes = 2;
        }
        if (segment.byteLength > MAX_JOURNAL_SEGMENT_BYTES) throw new Error('journal_segment_oversized');
        segments.push(segment);
        bytes += segment.byteLength - 2 + (segments.length > 1 ? 1 : 0);
      }
      if (segments.length < 2) return;
      this.compactionCursors.set(key, segments.at(-1)!.lastSequence);
      const events: GatewayEventEnvelope[] = [];
      for (const segment of segments) events.push(...await this.readSegment(accountId, conversationId, segment.id));
      const next = await this.writeSegment(accountId, conversationId, events);
      this.index.replaceSegments(accountId, conversationId, segments, next);
      for (const segment of segments) await unlink(this.segmentPath(accountId, conversationId, segment.id)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
  }

  private async cleanupOrphans(accountId: string, conversationId: string): Promise<void> {
    const key = this.directory(accountId, conversationId);
    let directory = this.cleanupDirectories.get(key);
    if (!directory) {
      try { directory = await opendir(key); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      this.cleanupDirectories.set(key, directory);
    }
    for (let n = 0; n < MAINTENANCE_FILES; n += 1) {
      const entry = await directory.read();
      if (!entry) {
        await directory.close();
        this.cleanupDirectories.delete(key);
        return;
      }
      const match = /^([a-f0-9-]{36})\.json(\.pending)?$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      if (!match[2] && this.index.hasSegment(accountId, conversationId, match[1]!)) continue;
      // Serialized with all writers for this stream; no in-flight file is removed.
      await unlink(resolve(key, entry.name)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }

  private async ensureStream(accountId: string, conversationId: string): Promise<JournalStreamState> {
    this.directory(accountId, conversationId);
    const existing = this.index.read(accountId, conversationId);
    if (existing) return existing;
    const retained = await this.legacy.exportRetained(accountId, conversationId);
    const events = [...new Map(retained.events.map(event => [event.eventId, event])).values()]
      .sort((a, b) => a.sequence - b.sequence);
    const writes = await this.writeSegments(accountId, conversationId, events);
    // Only a contiguous retained suffix certifies incremental replay coverage.
    // Legacy transient sequence gaps conservatively reset; new reservations do not.
    let replayFloor = retained.lastSequence;
    for (let n = events.length - 1; n >= 0 && events[n]!.sequence === replayFloor; n -= 1) replayFloor -= 1;
    const state = { lastSequence: retained.lastSequence, replayFloor, snapshot: projectConversationSnapshot([], events) };
    this.index.commit(accountId, conversationId, null, writes, state,
      this.projectTurnObservations(accountId, conversationId, events));
    return state;
  }

  private projectTurnObservations(
    accountId: string, conversationId: string, events: readonly GatewayEventEnvelope[],
  ): TurnTaskObservation[] {
    const observations = new Map<string, TurnTaskObservation>();
    for (const event of events) {
      if (event.accountId !== accountId || event.conversationId !== conversationId) continue;
      for (const turnId of traceObservationTurnIds(event)) {
        const previous = observations.get(turnId)
          ?? this.index.readTurnTaskObservation(accountId, conversationId, turnId);
        const observation = observeTurnTaskTrace({ accountId, conversationId, turnId }, previous, event);
        if (observation) observations.set(turnId, observation);
      }
    }
    return [...observations.values()];
  }

  private directory(accountId: string, conversationId: string): string {
    if (!isValidAccountId(accountId) || !isValidConversationId(conversationId)) throw new Error('Invalid journal identity');
    return resolve(this.root, accountId, `${conversationId}.segments`);
  }

  private segmentPath(accountId: string, conversationId: string, id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid journal segment identity');
    return resolve(this.directory(accountId, conversationId), `${id}.json`);
  }

  private async readSegment(accountId: string, conversationId: string, id: string): Promise<GatewayEventEnvelope[]> {
    const events: GatewayEventEnvelope[] = JSON.parse(await readFile(this.segmentPath(accountId, conversationId, id), 'utf8'));
    if (!Array.isArray(events) || events.some(event => event.accountId !== accountId || event.conversationId !== conversationId)) {
      throw new Error('journal_segment_corrupt');
    }
    return events;
  }

  private async writeSegment(accountId: string, conversationId: string, events: readonly GatewayEventEnvelope[]): Promise<JournalSegment> {
    const body = JSON.stringify(events);
    const byteLength = Buffer.byteLength(body);
    if (byteLength > MAX_JOURNAL_SEGMENT_BYTES) throw new Error('journal_segment_oversized');
    const id = randomUUID();
    const directory = this.directory(accountId, conversationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = this.segmentPath(accountId, conversationId, id);
    const temporary = `${path}.pending`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(body); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
    const dir = await open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    return { id, firstSequence: events[0]!.sequence, lastSequence: events.at(-1)!.sequence, byteLength };
  }

  private async writeSegments(
    accountId: string, conversationId: string, events: readonly GatewayEventEnvelope[],
  ): Promise<JournalSegmentWrite[]> {
    const writes: JournalSegmentWrite[] = [];
    let batch: GatewayEventEnvelope[] = [];
    let bytes = 2;
    const flush = async () => {
      if (!batch.length) return;
      writes.push({ segment: await this.writeSegment(accountId, conversationId, batch), events: batch });
      batch = [];
      bytes = 2;
    };
    for (const event of events) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (size + 2 > MAX_JOURNAL_SEGMENT_BYTES) throw new Error('journal_event_oversized');
      if (bytes + size + (batch.length ? 1 : 0) > MAX_JOURNAL_SEGMENT_BYTES) await flush();
      bytes += size + (batch.length ? 1 : 0);
      batch.push(event);
    }
    await flush();
    return writes;
  }

  private serialized<T>(accountId: string, conversationId: string, operation: () => Promise<T>): Promise<T> {
    const key = this.directory(accountId, conversationId);
    const pending = (operations.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    operations.set(key, pending);
    return pending.finally(() => { if (operations.get(key) === pending) operations.delete(key); });
  }
}
