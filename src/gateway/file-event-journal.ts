/**
 * Gateway 文件事件日志（ADR-0031 第 8、9 节）。
 *
 * 每 Conversation 一个版本化 JSON 文件，原子写入、单调 sequence、重复
 * eventId 幂等、有界保留。账户/会话 ID 经校验防止路径穿越。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isValidAccountId } from '../account/account-id.js';
import { isValidConversationId } from '../session/conversation-types.js';
import {
  GATEWAY_EVENT_KINDS,
  gatewayEventPayloadBytes,
  isTerminalGatewayEvent,
  MAX_GATEWAY_EVENT_PAYLOAD_BYTES,
  sanitizeGatewayEventPayload,
  type GatewayEventEnvelope,
  type GatewayReplay,
} from './client-events.js';
import type { EventJournal } from './event-journal.js';

interface JournalFile {
  readonly version: 2;
  lastSequence: number;
  events: GatewayEventEnvelope[];
}

interface StoredJournalFile {
  readonly version: 1 | 2;
  readonly lastSequence: number;
  readonly events: unknown[];
}

const MAX_EVENTS_PER_CONVERSATION = 200;
const MAX_WORKSPACE_ACTIVITY_SNAPSHOTS = 100;

export class FileEventJournal implements EventJournal {
  private readonly appendTails = new Map<string, Promise<void>>();

  constructor(private readonly rootDir: string) {}

  async append(event: GatewayEventEnvelope): Promise<GatewayEventEnvelope> {
    return (await this.appendBatch([event]))[0]!;
  }

  async appendBatch(events: GatewayEventEnvelope[]): Promise<GatewayEventEnvelope[]> {
    if (events.length === 0) return [];
    if (events.some(event => event.protocolVersion !== 2)) {
      throw new Error('Gateway event protocol version must be 2');
    }
    const first = events[0]!;
    if (events.some(event =>
      event.accountId !== first.accountId
      || event.conversationId !== first.conversationId
    )) {
      throw new Error('Gateway event batch must target one account and conversation');
    }
    const key = `${first.accountId}\0${first.conversationId}`;
    const previous = this.appendTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.appendTails.set(key, tail);
    await previous;
    try {
      return await this.appendBatchSerial(events);
    } finally {
      release();
      if (this.appendTails.get(key) === tail) {
        this.appendTails.delete(key);
      }
    }
  }

  private async appendBatchSerial(
    events: GatewayEventEnvelope[],
  ): Promise<GatewayEventEnvelope[]> {
    const first = events[0]!;
    const file = await this.read(first.accountId, first.conversationId);
    const byId = new Map(file.events.map(event => [event.eventId, event]));
    const appended: GatewayEventEnvelope[] = [];
    let changed = false;
    for (const event of events) {
      const existing = byId.get(event.eventId);
      if (existing) {
        appended.push(existing);
        continue;
      }
      assertPayloadSize(event.payload);
      const payload = sanitizeGatewayEventPayload(event.payload);
      assertPayloadSize(payload);
      const stored = {
        ...event,
        sequence: file.lastSequence + 1,
        payload,
      };
      file.lastSequence = stored.sequence;
      file.events.push(stored);
      byId.set(stored.eventId, stored);
      appended.push(stored);
      changed = true;
    }
    if (!changed) return appended;
    file.events = compactEvents(file.events);
    await this.write(file, first.accountId, first.conversationId);
    return appended;
  }

  async replay(
    accountId: string,
    conversationId: string,
    afterSequence?: number,
  ): Promise<GatewayReplay> {
    const file = await this.read(accountId, conversationId);
    const oldestAvailableSequence = file.events[0]?.sequence;
    const staleCursor = afterSequence !== undefined
      && oldestAvailableSequence !== undefined
      && afterSequence < oldestAvailableSequence - 1;
    const snapshot = buildReplaySnapshot(file.events);
    const snapshotIds = new Set(snapshot.map(event => event.eventId));
    const snapshotSequence = snapshot.at(-1)?.sequence ?? file.lastSequence;
    const cursor = staleCursor ? snapshotSequence : afterSequence ?? 0;
    const deltas = file.events.filter(event =>
      event.sequence > cursor
      && !snapshotIds.has(event.eventId)
      && !isCompactedSnapshotSource(event)
    );
    return { lastSequence: file.lastSequence, snapshot, deltas };
  }

  private path(accountId: string, conversationId: string): string {
    if (!isValidAccountId(accountId)) throw new Error(`Invalid account id: ${accountId}`);
    if (!isValidConversationId(conversationId)) throw new Error(`Invalid conversation id: ${conversationId}`);
    const path = resolve(this.rootDir, accountId, `${conversationId}.json`);
    if (!path.startsWith(resolve(this.rootDir))) {
      throw new Error(`Invalid journal path: ${accountId}/${conversationId}`);
    }
    return path;
  }

  private async read(accountId: string, conversationId: string): Promise<JournalFile> {
    try {
      const raw = await readFile(this.path(accountId, conversationId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isStoredJournalFile(parsed)) {
        throw new Error(`Invalid journal file: ${accountId}/${conversationId}`);
      }
      const events = parsed.events.map(event => normalizeStoredEvent(
        event,
        accountId,
        conversationId,
      ));
      if (events.some(event => event.sequence > parsed.lastSequence)) {
        throw new Error(`Invalid journal file: ${accountId}/${conversationId}`);
      }
      const file: JournalFile = {
        version: 2,
        lastSequence: parsed.lastSequence,
        events: events.map(event => {
          const payload = boundHistoricalPayload(sanitizeGatewayEventPayload(event.payload));
          return { ...event, payload };
        }),
      };
      if (parsed.version === 1) {
        await this.write(file, accountId, conversationId);
      }
      return file;
    } catch (error) {
      if (isMissingFile(error)) return { version: 2, lastSequence: 0, events: [] };
      throw error;
    }
  }

  private async write(
    file: JournalFile,
    accountId: string,
    conversationId: string,
  ): Promise<void> {
    const path = this.path(accountId, conversationId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(file, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporaryPath, path);
  }
}

function isStoredJournalFile(value: unknown): value is StoredJournalFile {
  if (!isRecord(value)) return false;
  return (value.version === 1 || value.version === 2)
    && typeof value.lastSequence === 'number'
    && Number.isSafeInteger(value.lastSequence)
    && value.lastSequence >= 0
    && Array.isArray(value.events);
}

function normalizeStoredEvent(
  value: unknown,
  accountId: string,
  conversationId: string,
): GatewayEventEnvelope {
  if (!isRecord(value)
    || (value.protocolVersion !== 1 && value.protocolVersion !== 2)
    || typeof value.eventId !== 'string'
    || value.eventId.length === 0
    || typeof value.sequence !== 'number'
    || !Number.isSafeInteger(value.sequence)
    || value.sequence <= 0
    || value.accountId !== accountId
    || value.conversationId !== conversationId
    || (value.requestId !== null && typeof value.requestId !== 'string')
    || (value.turnId !== null && typeof value.turnId !== 'string')
    || !GATEWAY_EVENT_KINDS.includes(value.kind as never)
    || !('payload' in value)
    || typeof value.occurredAt !== 'string') {
    throw new Error(`Invalid journal event: ${accountId}/${conversationId}`);
  }
  return {
    protocolVersion: 2,
    eventId: value.eventId,
    sequence: value.sequence,
    accountId,
    conversationId,
    requestId: value.requestId,
    turnId: value.turnId,
    kind: value.kind as GatewayEventEnvelope['kind'],
    payload: value.payload,
    occurredAt: value.occurredAt,
  };
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function assertPayloadSize(payload: unknown): void {
  if (gatewayEventPayloadBytes(payload) <= MAX_GATEWAY_EVENT_PAYLOAD_BYTES) return;
  throw new Error(
    `Gateway event payload exceeds ${MAX_GATEWAY_EVENT_PAYLOAD_BYTES} bytes`,
  );
}

function boundHistoricalPayload(payload: unknown): unknown {
  if (gatewayEventPayloadBytes(payload) <= MAX_GATEWAY_EVENT_PAYLOAD_BYTES) return payload;
  if (isRecord(payload) && Array.isArray(payload.lines)) {
    const metadata = { ...payload };
    delete metadata.lines;
    const lines = payload.lines.filter((line): line is string => typeof line === 'string');
    const bounded = boundPayloadLines(lines, metadata);
    return { ...metadata, lines: bounded, truncated: true };
  }
  return {
    truncated: true,
    message: 'Historical Gateway event payload exceeded the current replay limit.',
  };
}

function buildReplaySnapshot(events: readonly GatewayEventEnvelope[]): GatewayEventEnvelope[] {
  const snapshot = events.filter(event => isTerminalGatewayEvent(event.kind));
  snapshot.push(...retainedResultEvents(events));
  const workspaceDirectory = findLast(
    events,
    event => event.kind === 'workspace_directory_snapshot',
  );
  if (workspaceDirectory) snapshot.push(workspaceDirectory);
  snapshot.push(...latestWorkspaceActivityEvents(events));
  const conversationSnapshot = buildConversationSnapshot(events);
  if (conversationSnapshot) snapshot.push(conversationSnapshot);
  const taskProjection = findLast(events, event => event.kind === 'task_projection');
  if (taskProjection) snapshot.push(taskProjection);
  const traceSnapshot = buildTraceSnapshot(events);
  if (traceSnapshot) snapshot.push(traceSnapshot);
  return uniqueEvents(snapshot).sort((left, right) => left.sequence - right.sequence);
}

function compactEvents(events: readonly GatewayEventEnvelope[]): GatewayEventEnvelope[] {
  if (events.length <= MAX_EVENTS_PER_CONVERSATION) return [...events];
  const resultEvents = retainedResultEvents(events);
  const resultEventIds = new Set(resultEvents.map(event => event.eventId));
  const retained = events
    .filter(event => !resultEventIds.has(event.eventId))
    .slice(-MAX_EVENTS_PER_CONVERSATION);
  const retainedIds = new Set(retained.map(event => event.eventId));
  const snapshots = [
    findLast(events, event => event.kind === 'workspace_directory_snapshot'),
    ...latestWorkspaceActivityEvents(events),
    buildConversationSnapshot(events),
    findLast(events, event => event.kind === 'task_projection'),
    buildTraceSnapshot(events),
  ].filter((event): event is GatewayEventEnvelope => Boolean(event))
    .filter(event => !retainedIds.has(event.eventId));
  return [...retained, ...resultEvents, ...snapshots]
    .sort((left, right) => left.sequence - right.sequence);
}

function latestWorkspaceActivityEvents(
  events: readonly GatewayEventEnvelope[],
): GatewayEventEnvelope[] {
  const latestByConversation = new Map<string, GatewayEventEnvelope>();
  for (const event of events) {
    if (event.kind !== 'workspace_activity_changed' || !isRecord(event.payload)) continue;
    const workspaceId = stringValue(event.payload.workspaceId);
    const conversationId = stringValue(event.payload.conversationId);
    if (!workspaceId || !conversationId) continue;
    latestByConversation.set(`${workspaceId}\0${conversationId}`, event);
  }
  return [...latestByConversation.values()]
    .filter(event => {
      if (!isRecord(event.payload) || !isRecord(event.payload.activity)) return false;
      return event.payload.activity.state !== 'idle';
    })
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-MAX_WORKSPACE_ACTIVITY_SNAPSHOTS);
}

function retainedResultEvents(
  events: readonly GatewayEventEnvelope[],
): GatewayEventEnvelope[] {
  const resultIds = new Set(
    events
      .filter(isResultEvent)
      .map(resultIdFrom)
      .filter((resultId): resultId is string => Boolean(resultId)),
  );
  const latestResultId = [...events]
    .reverse()
    .map(resultIdFrom)
    .find((resultId): resultId is string => Boolean(resultId));
  return events.filter(event => {
    const resultId = resultIdFrom(event);
    if (!resultId || !resultIds.has(resultId)) return false;
    if (resultId === latestResultId) return true;
    return event.kind === 'result_delivery_available' || event.kind === 'result_completed';
  });
}

function isResultEvent(event: GatewayEventEnvelope): boolean {
  return event.kind === 'result_completed'
    || event.kind === 'result_chunk'
    || event.kind === 'result_delivery_available';
}

function resultIdFrom(event: GatewayEventEnvelope): string | null {
  if (!isRecord(event.payload)) return null;
  return typeof event.payload.resultId === 'string' ? event.payload.resultId : null;
}

function isCompactedSnapshotSource(event: GatewayEventEnvelope): boolean {
  return event.kind === 'conversation_snapshot'
    || event.kind === 'task_projection'
    || (
      event.kind === 'trace_delta'
      && isRecord(event.payload)
      && Array.isArray(event.payload.events)
      && event.payload.events.length > 0
    );
}

function buildTraceSnapshot(
  events: readonly GatewayEventEnvelope[],
): GatewayEventEnvelope | null {
  const traceEvents = events
    .filter(event => event.kind === 'trace_delta')
    .flatMap(event => {
      const payload = isRecord(event.payload) ? event.payload : {};
      return Array.isArray(payload.events) ? payload.events : [];
    })
    .filter(isRecord);
  if (traceEvents.length === 0) return null;

  const byId = new Map<string, Record<string, unknown>>();
  for (const event of traceEvents) {
    const id = typeof event.id === 'string'
      ? event.id
      : `${String(event.turnId ?? 'turn_unknown')}:${String(event.sequence ?? byId.size + 1)}`;
    byId.set(id, event);
  }
  const ordered = [...byId.values()].sort((left, right) => (
    numberValue(left.sequence) - numberValue(right.sequence)
      || stringValue(left.occurredAt).localeCompare(stringValue(right.occurredAt))
  ));
  const latest = [...events].reverse().find(event => (
    event.kind === 'trace_delta'
      && isRecord(event.payload)
      && Array.isArray(event.payload.events)
      && event.payload.events.length > 0
  ));
  if (!latest) return null;
  const payload = {
    ...(isRecord(latest.payload) ? latest.payload : {}),
    events: boundTraceEvents(ordered),
    replay: true,
  };
  return {
    ...latest,
    payload,
  };
}

function boundTraceEvents(events: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const bounded: Record<string, unknown>[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = [events[index]!, ...bounded];
    if (gatewayEventPayloadBytes({ events: candidate, replay: true }) > MAX_GATEWAY_EVENT_PAYLOAD_BYTES) {
      break;
    }
    bounded.unshift(events[index]!);
  }
  return bounded;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function buildConversationSnapshot(
  events: readonly GatewayEventEnvelope[],
): GatewayEventEnvelope | null {
  const snapshots = events.filter(event => event.kind === 'conversation_snapshot');
  const latest = snapshots.at(-1);
  if (!latest) return null;

  let lines: string[] = [];
  let truncated = false;
  for (const event of snapshots) {
    const payload = event.payload as { from?: unknown; lines?: unknown };
    const nextLines = Array.isArray(payload.lines)
      ? payload.lines.filter((line): line is string => typeof line === 'string')
      : [];
    const from = typeof payload.from === 'number' && Number.isSafeInteger(payload.from)
      ? Math.max(0, payload.from)
      : lines.length;
    if (from === 0) {
      lines = [...nextLines];
    } else if (from <= lines.length) {
      lines.splice(from, lines.length - from, ...nextLines);
    } else {
      truncated = true;
      lines.push(...nextLines);
    }
  }

  const latestPayload = isRecord(latest.payload) ? latest.payload : {};
  const metadata = { ...latestPayload };
  delete metadata.from;
  delete metadata.lines;
  delete metadata.truncated;
  const bounded = boundSnapshotLines(lines, metadata, truncated);
  return {
    ...latest,
    payload: {
      ...metadata,
      from: 0,
      lines: bounded.lines,
      truncated: bounded.truncated,
    },
  };
}

function boundSnapshotLines(
  lines: readonly string[],
  metadata: Readonly<Record<string, unknown>>,
  alreadyTruncated: boolean,
): { lines: string[]; truncated: boolean } {
  const bounded: string[] = [];
  let truncated = alreadyTruncated;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = [lines[index]!, ...bounded];
    const payload = { ...metadata, from: 0, lines: candidate, truncated: true };
    if (gatewayEventPayloadBytes(payload) > MAX_GATEWAY_EVENT_PAYLOAD_BYTES) {
      truncated = true;
      break;
    }
    bounded.unshift(lines[index]!);
  }
  return {
    lines: bounded,
    truncated: truncated || bounded.length < lines.length,
  };
}

function boundPayloadLines(
  lines: readonly string[],
  metadata: Readonly<Record<string, unknown>>,
): string[] {
  const bounded: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = [lines[index]!, ...bounded];
    if (gatewayEventPayloadBytes({ ...metadata, lines: candidate, truncated: true })
      > MAX_GATEWAY_EVENT_PAYLOAD_BYTES) {
      break;
    }
    bounded.unshift(lines[index]!);
  }
  return bounded;
}

function findLast(
  events: readonly GatewayEventEnvelope[],
  predicate: (event: GatewayEventEnvelope) => boolean,
): GatewayEventEnvelope | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (predicate(event)) return event;
  }
  return undefined;
}

function uniqueEvents(events: readonly GatewayEventEnvelope[]): GatewayEventEnvelope[] {
  const seen = new Set<string>();
  return events.filter(event => {
    if (seen.has(event.eventId)) return false;
    seen.add(event.eventId);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
