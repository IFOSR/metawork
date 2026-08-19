/**
 * Gateway 文件事件日志（ADR-0031 第 8、9 节）。
 *
 * 每 Conversation 一个版本化 JSON 文件，原子写入、单调 sequence、重复
 * eventId 幂等、有界保留。账户/会话 ID 经校验防止路径穿越。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isValidAccountId } from '../account/account-id.js';
import { isValidConversationId } from '../session/conversation-types.js';
import {
  gatewayEventPayloadBytes,
  isTerminalGatewayEvent,
  MAX_GATEWAY_EVENT_PAYLOAD_BYTES,
  sanitizeGatewayEventPayload,
  type GatewayEventEnvelope,
  type GatewayReplay,
} from './client-events.js';
import type { EventJournal } from './event-journal.js';

interface JournalFile {
  readonly version: 1;
  lastSequence: number;
  events: GatewayEventEnvelope[];
}

const MAX_EVENTS_PER_CONVERSATION = 200;

export class FileEventJournal implements EventJournal {
  private readonly appendTails = new Map<string, Promise<void>>();

  constructor(private readonly rootDir: string) {}

  async append(event: GatewayEventEnvelope): Promise<GatewayEventEnvelope> {
    const key = `${event.accountId}\0${event.conversationId}`;
    const previous = this.appendTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.appendTails.set(key, tail);
    await previous;
    try {
      return await this.appendSerial(event);
    } finally {
      release();
      if (this.appendTails.get(key) === tail) {
        this.appendTails.delete(key);
      }
    }
  }

  private async appendSerial(event: GatewayEventEnvelope): Promise<GatewayEventEnvelope> {
    const file = await this.read(event.accountId, event.conversationId);
    const existing = file.events.find(item => item.eventId === event.eventId);
    if (existing) return existing;

    assertPayloadSize(event.payload);
    const payload = sanitizeGatewayEventPayload(event.payload);
    assertPayloadSize(payload);
    const sequence = file.lastSequence + 1;
    const appended = { ...event, sequence, payload };
    file.events.push(appended);
    if (file.events.length > MAX_EVENTS_PER_CONVERSATION) {
      file.events = file.events.slice(-MAX_EVENTS_PER_CONVERSATION);
    }
    file.lastSequence = sequence;
    await this.write(file, event.accountId, event.conversationId);
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
      const parsed = JSON.parse(raw) as Partial<JournalFile>;
      if (parsed.version !== 1
        || typeof parsed.lastSequence !== 'number'
        || !Array.isArray(parsed.events)) {
        throw new Error(`Invalid journal file: ${accountId}/${conversationId}`);
      }
      return {
        version: 1,
        lastSequence: parsed.lastSequence,
        events: (parsed.events as GatewayEventEnvelope[]).map(event => {
          const payload = boundHistoricalPayload(sanitizeGatewayEventPayload(event.payload));
          return { ...event, payload };
        }),
      };
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, lastSequence: 0, events: [] };
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
    const temporaryPath = `${path}.tmp-${process.pid}`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(file, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporaryPath, path);
  }
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
  const conversationSnapshot = buildConversationSnapshot(events);
  if (conversationSnapshot) snapshot.push(conversationSnapshot);
  const taskProjection = findLast(events, event => event.kind === 'task_projection');
  if (taskProjection) snapshot.push(taskProjection);
  return uniqueEvents(snapshot).sort((left, right) => left.sequence - right.sequence);
}

function isCompactedSnapshotSource(event: GatewayEventEnvelope): boolean {
  return event.kind === 'conversation_snapshot' || event.kind === 'task_projection';
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
