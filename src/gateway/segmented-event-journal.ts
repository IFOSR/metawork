import { recordNavigationRead } from '../utils/navigation-diagnostics.js';
import { randomUUID } from 'node:crypto';
import { mkdir, open, opendir, readFile, rename, unlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Dir } from 'node:fs';
import { resolve } from 'node:path';
import { isPathInsideDirectory } from '../utils/paths.js';
import { isValidAccountId } from '../account/account-id.js';
import { isValidConversationId } from '../session/conversation-types.js';
import type { EventJournal, TracePage } from './event-journal.js';
import {
  decodeTracePageCursor,
  encodeTracePageCursor,
  tracePosition,
} from './trace-page-cursor.js';
import { projectIndexedTraceEvents } from './trace-read-model.js';
import type { ConversationReadModel } from '../session/conversation-read-model.js';
import { ConversationReadProjector } from '../session/conversation-read-projector.js';
import type { EventJournalSegmentIndex, JournalSegment, JournalStreamState, ConversationSnapshot, JournalSegmentWrite } from './event-journal-segment-index.js';
import {
  boundGatewayEventPayload, gatewayEventPayloadBytes, MAX_GATEWAY_EVENT_PAYLOAD_BYTES, sanitizeGatewayEventPayload,
  type GatewayEventEnvelope, type GatewayReplay,
} from './client-events.js';
import { projectConversationSnapshot } from './conversation-snapshot-store.js';
import { renameReplacingTarget } from '../utils/directory-pointer.js';
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
    private readonly readModel?: ConversationReadModel,
    private readonly onProjectionError: (error: unknown) => void = () => undefined,
  ) {}

  async deleteConversation(accountId: string, conversationId: string): Promise<void> {
    await this.serialized(accountId, conversationId, async () => {
      const dir = this.directory(accountId, conversationId);
      if (!this.index.purge || !this.index.isDeleted?.(accountId, conversationId)) throw new Error('deletion_not_fenced');
      await rm(dir, { recursive: true, force: true });
      await rm(resolve(this.root, accountId, `${conversationId}.json`), { force: true });
      this.index.purge(accountId, conversationId);
    });
  }

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
      if (this.index.isDeleted?.(first.accountId, first.conversationId)) throw new Error('conversation_deleted');
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
        const stored = {
          ...event,
          sequence: ++sequence,
          payload: boundGatewayEventPayload(sanitizeGatewayEventPayload(event.payload)),
        };
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
      this.projectFresh(first.accountId, first.conversationId, state.lastSequence, fresh, sequence);
      return result;
    });
  }

  snapshot(accountId: string, conversationId: string): Promise<ConversationSnapshot> {
    return this.serialized(accountId, conversationId, async () => {
      if (this.index.isDeleted?.(accountId, conversationId)) throw new Error('conversation_deleted');
      const state = await this.ensureStream(accountId, conversationId);
      return { ...state, snapshotVersion: 1, deltas: [] };
    });
  }

  readTurnTaskObservation(accountId: string, conversationId: string, turnId: string): Promise<{
    lastSequence: number; observation: TurnTaskObservation | null;
  }> {
    return this.serialized(accountId, conversationId, async () => {
      if (this.index.isDeleted?.(accountId, conversationId)) throw new Error('conversation_deleted');
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
      if (this.index.isDeleted?.(accountId, conversationId)) throw new Error('conversation_deleted');
      const state = await this.ensureStream(accountId, conversationId);
      const deltas: GatewayEventEnvelope[] = [];
      for (const segment of this.index.segments(accountId, conversationId, afterSequence)) {
        deltas.push(...(await this.readSegment(accountId, conversationId, segment.id))
          .filter(event => event.sequence > afterSequence));
      }
      return { lastSequence: state.lastSequence, snapshot: state.snapshot, deltas };
    });
  }

  readTracePage(accountId: string, conversationId: string, turnId: string, cursor?: string, limit = 100, latest = false): Promise<TracePage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return Promise.reject(new Error('invalid_trace_page_limit'));
    const after = decodeTracePageCursor(cursor, [accountId, conversationId, turnId]);
    if (cursor && !after) return Promise.reject(new Error('invalid_trace_cursor'));
    return this.serialized(accountId, conversationId, async () => {
      // Never open audit segment bodies on the interactive detail path.
      const state = this.index.read(accountId, conversationId);
      const checkpoint = this.index.traceCheckpoint(accountId, conversationId);
      const preparing = state !== null && (checkpoint ?? -1) < state.lastSequence;
      const selected = this.index.tracePage(accountId, conversationId, turnId, after, limit, MAX_JOURNAL_RESUME_BYTES, latest);
      const page = selected.events;
      const first = page[0] ? tracePosition(page[0]) : null;
      const last = page.at(-1) ? tracePosition(page.at(-1)!) : null;
      return {
        turnId,
        streamRevision: state?.lastSequence ?? 0,
        ...(preparing ? { preparing: true } : {}),
        firstSequence: first?.sequence ?? null,
        lastSequence: last?.sequence ?? null,
        events: page,
        nextCursor: selected.hasMore && last ? encodeTracePageCursor(last, [accountId, conversationId, turnId]) : null,
      };
    });
  }

  resume(accountId: string, conversationId: string, afterSequence: number): Promise<GatewayReplay> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) return Promise.reject(new Error('invalid_journal_cursor'));
    return this.serialized(accountId, conversationId, async () => {
      if (this.index.isDeleted?.(accountId, conversationId)) throw new Error('conversation_deleted');
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
      if (this.index.isDeleted?.(accountId, conversationId)) throw new Error('conversation_deleted');
      const state = await this.ensureStream(accountId, conversationId);
      this.index.commit(accountId, conversationId, state.lastSequence, [], {
        ...state, lastSequence: state.lastSequence + 1,
      }, []);
      this.projectFresh(accountId, conversationId, state.lastSequence, [], state.lastSequence + 1);
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
  maintain(accountId: string, conversationId: string): Promise<{ done: boolean; didWork: boolean }> {
    return this.serialized(accountId, conversationId, async () => {
      // 分段文件可能丢失（Pod 重建/快照恢复时遗失）：首轮维护会以 ENOENT 失败，
      // 此时隔离丢失的分段（墓碑替换）并重试一次，日志即可收敛而非永远刷 ENOENT。
      try {
        return await this.maintainOnce(accountId, conversationId);
      } catch (error) {
        // 兜底：未预料的 ENOENT 也走一次隔离再重试；正常路径由 maintainOnce
        // 开头的主动扫描完成隔离。
        if (!((error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
        const lost = await this.quarantineLostSegments(accountId, conversationId);
        if (!lost.length) throw error;
        return await this.maintainOnce(accountId, conversationId);
      }
    });
  }

  private async maintainOnce(accountId: string, conversationId: string): Promise<{ done: boolean; didWork: boolean }> {
    if (this.index.isDeleted?.(accountId, conversationId)) throw new Error('conversation_deleted');
    const state = await this.ensureStream(accountId, conversationId);
    // 维护路径全部是宽恕读，不会再抛 ENOENT，所以这里主动扫描索引里指向
    // 已丢失文件的分段（Pod 重建/快照恢复时遗失）并隔离——否则压缩合并不
    // 到的丢失条目（如仅剩单段）会永远残留，面向用户的 replay 仍会 ENOENT。
    await this.quarantineLostSegments(accountId, conversationId);
    // `done` alone cannot tell an idle pass from the batch that finally
    // converges a stream, so the pass reports the durable progress it made.
    const traceBefore = this.index.traceCheckpoint(accountId, conversationId) ?? 0;
    const viewBefore = this.readModel?.head(accountId, conversationId)?.journalSequence ?? 0;
    const indexed = await this.rebuildTraceBatch(accountId, conversationId, state.lastSequence);
    const projected = await this.rebuildViewBatch(accountId, conversationId, state.lastSequence);
    await this.compactBatch(accountId, conversationId);
    await this.cleanupOrphans(accountId, conversationId);
    const pendingCleanup = this.cleanupDirectories.has(this.directory(accountId, conversationId));
    const done = indexed && projected && !pendingCleanup;
    const traceAfter = this.index.traceCheckpoint(accountId, conversationId) ?? 0;
    const viewAfter = this.readModel?.head(accountId, conversationId)?.journalSequence ?? 0;
    return {
      done,
      didWork: !done
        || traceAfter !== traceBefore
        || viewAfter !== viewBefore
        || pendingCleanup,
    };
  }

  /**
   * 隔离磁盘上已丢失的分段：把它们的索引条目替换为一个空墓碑分段。
   *
   * 文件丢失（Pod 重建/快照恢复时遗失）后数据无法找回，但日志必须能收敛——
   * 否则维护每次都 ENOENT、无限重试。丢失的事件视为不可恢复并记录。
   */
  async quarantineLostSegments(accountId: string, conversationId: string): Promise<string[]> {
    const entries = this.index.segments(accountId, conversationId, 0, Number.MAX_SAFE_INTEGER);
    const lost = entries.filter(segment => !existsSync(this.segmentPath(accountId, conversationId, segment.id)));
    if (!lost.length) return [];
    for (const segment of lost) {
      // 逐段隔离：墓碑沿用该分段自身的序号范围，避免与存活分段的区间重叠
      // （cursor/resume 都依赖序号区间的连续覆盖）。先写文件再替换索引，
      // 与压缩同一崩溃安全次序。
      const tombstone = await this.writeTombstoneSegment(accountId, conversationId, segment);
      this.index.replaceSegments(accountId, conversationId, [segment], tombstone);
    }
    for (const segment of lost) {
      await unlink(this.segmentPath(accountId, conversationId, segment.id)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    console.error(`journal_segment_quarantined: ${JSON.stringify({ accountId, conversationId, segments: lost.map(segment => segment.id) })}`);
    return lost.map(segment => segment.id);
  }

  private async rebuildTraceBatch(accountId: string, conversationId: string, lastSequence: number): Promise<boolean> {
    const checkpoint = this.index.traceCheckpoint(accountId, conversationId);
    if (checkpoint === lastSequence) return true;
    const segments = this.index.segments(accountId, conversationId, checkpoint ?? 0, 1);
    const segment = segments[0];
    if (!segment) {
      this.index.indexTraceEvents(accountId, conversationId, [], lastSequence);
      return true;
    }
    const events = await this.readSegmentForgiving(accountId, conversationId, segment);
    this.index.indexTraceEvents(accountId, conversationId, projectIndexedTraceEvents(events), segment.lastSequence);
    return segment.lastSequence === lastSequence;
  }

  private projectFresh(accountId: string, conversationId: string, expected: number,
    events: readonly GatewayEventEnvelope[], through: number): void {
    if (!this.readModel || (this.readModel.head(accountId, conversationId)?.journalSequence ?? 0) !== expected) return;
    try {
      new ConversationReadProjector(this.readModel).apply(accountId, conversationId, events, through);
    } catch (error) {
      // The source commit succeeded. Publish it; maintenance retries from the
      // unchanged view checkpoint instead of making execution retry a durable fact.
      this.onProjectionError(error);
    }
  }

  /** Bounded source read for an invisible staging epoch; serialized with appends. */
  projectReadBatch(accountId: string, conversationId: string, view: ConversationReadModel): Promise<boolean> {
    return this.serialized(accountId, conversationId, async () => {
      if (this.index.isDeleted?.(accountId, conversationId)) throw new Error('conversation_deleted');
      const state = await this.ensureStream(accountId, conversationId);
      return this.rebuildViewBatch(accountId, conversationId, state.lastSequence, view);
    });
  }

  private async rebuildViewBatch(accountId: string, conversationId: string, lastSequence: number,
    view = this.readModel): Promise<boolean> {
    if (!view) return true;
    const checkpoint = view.head(accountId, conversationId)?.journalSequence ?? 0;
    if (checkpoint === lastSequence) {
      if (!view.head(accountId, conversationId)) view.commit(accountId, conversationId, [], lastSequence);
      return true;
    }
    const segment = this.index.segments(accountId, conversationId, checkpoint, 1)[0];
    const events = segment ? await this.readSegmentForgiving(accountId, conversationId, segment) : [];
    const through = segment?.lastSequence ?? lastSequence;
    new ConversationReadProjector(view).apply(accountId, conversationId, events, through);
    return through === lastSequence;
  }

  async close(): Promise<void> {
    // The owner stops the maintenance timer before closing the journal.
    await Promise.all([...operations.entries()]
      .filter(([key]) => isPathInsideDirectory(key, this.root)).map(([, pending]) => pending.catch(() => undefined)));
    for (const directory of this.cleanupDirectories.values()) await directory.close();
    this.cleanupDirectories.clear();
  }

  private async compactBatch(accountId: string, conversationId: string): Promise<void> {
      const key = this.directory(accountId, conversationId);
      const cursor = this.compactionCursors.get(key) ?? 0;
      const candidates = this.index.segments(accountId, conversationId, cursor, MAINTENANCE_SEGMENTS);
      const nextCursor = candidates.length === MAINTENANCE_SEGMENTS
        ? candidates.at(-1)!.lastSequence : 0;
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
      if (segments.length < 2) {
        this.compactionCursors.set(key, nextCursor);
        return;
      }
      const events: GatewayEventEnvelope[] = [];
      for (const segment of segments) events.push(...await this.readSegmentForgiving(accountId, conversationId, segment));
      const next = await this.writeSegment(accountId, conversationId, events);
      this.index.replaceSegments(accountId, conversationId, segments, next);
      // A failed read/write must retry the same batch. Advancing before commit
      // made the following empty pass falsely report recovery and reset backoff,
      // while the missing segment was still referenced by the durable index.
      this.compactionCursors.set(key, segments.at(-1)!.lastSequence);
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
    const body = await readFile(this.segmentPath(accountId, conversationId, id), 'utf8');
    recordNavigationRead('journal_segment_read', Buffer.byteLength(body));
    const events: GatewayEventEnvelope[] = JSON.parse(body);
    if (!Array.isArray(events) || events.some(event => event.accountId !== accountId || event.conversationId !== conversationId)) {
      throw new Error('journal_segment_corrupt');
    }
    return events;
  }

  /**
   * 维护路径专用的容错读取：分段**文件**丢失（Pod 重建/快照恢复时遗失）时返回空
   * 并记录——数据已无法找回，但日志必须能越过它收敛，不能永远 ENOENT 刷屏。
   * 仅限维护路径：面向用户的 replay 仍走严格读取（此时该分段应已被压缩替换）。
   */
  private async readSegmentForgiving(accountId: string, conversationId: string, segment: JournalSegment): Promise<GatewayEventEnvelope[]> {
    try {
      return await this.readSegment(accountId, conversationId, segment.id);
    } catch (error) {
      if (!((error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
      console.error(`journal_segment_lost: ${JSON.stringify({ accountId, conversationId, segment: segment.id, lastSequence: segment.lastSequence })}`);
      return [];
    }
  }

  private async writeSegment(accountId: string, conversationId: string, events: readonly GatewayEventEnvelope[]): Promise<JournalSegment> {
    const body = JSON.stringify(events);
    const byteLength = Buffer.byteLength(body);
    if (byteLength > MAX_JOURNAL_SEGMENT_BYTES) throw new Error('journal_segment_oversized');
    const id = await this.writeSegmentFile(accountId, conversationId, body);
    return { id, firstSequence: events[0]!.sequence, lastSequence: events.at(-1)!.sequence, byteLength };
  }

  /**
   * 丢失分段的空墓碑：文件真实存在（严格读取得到空列表），序号范围沿用原
   * 分段，保持流的序号覆盖连续。隔离后 replay/resume 不再触碰丢失的文件。
   */
  private async writeTombstoneSegment(accountId: string, conversationId: string, segment: JournalSegment): Promise<JournalSegment> {
    const id = await this.writeSegmentFile(accountId, conversationId, '[]');
    return { id, firstSequence: segment.firstSequence, lastSequence: segment.lastSequence, byteLength: 2 };
  }

  /** Atomic segment-body write shared by event segments and quarantine tombstones. */
  private async writeSegmentFile(accountId: string, conversationId: string, body: string): Promise<string> {
    const id = randomUUID();
    const directory = this.directory(accountId, conversationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = this.segmentPath(accountId, conversationId, id);
    const temporary = `${path}.pending`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(body); await handle.sync(); }
    finally { await handle.close(); }
    await renameReplacingTarget(temporary, path);
    // Windows cannot fsync directories (FlushFileBuffers needs GENERIC_WRITE).
    if (process.platform !== 'win32') {
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
    return id;
  }

  private async writeSegments(
    accountId: string, conversationId: string, events: readonly GatewayEventEnvelope[],
  ): Promise<JournalSegmentWrite[]> {
    const writes: JournalSegmentWrite[] = [];
    let batch: GatewayEventEnvelope[] = [];
    let bytes = 2;
    const flush = async () => {
      if (!batch.length) return;
      writes.push({ segment: await this.writeSegment(accountId, conversationId, batch), events: batch,
        traceEvents: projectIndexedTraceEvents(batch) });
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
