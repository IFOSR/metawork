import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ConversationTurn } from '../management/web-session-types.js';
import { boundWebSessionTurns } from '../management/web-session-types.js';
import { isValidConversationId } from '../session/conversation-types.js';
import { writeWindowsPrivateJson, type WindowsPrivateFileRoot } from '../platform/windows-private-files.js';
import type {
  ConversationHistoryStore, ConversationHistoryPage, ConversationHistoryRequest,
} from '../session/conversation-history-store.js';

export const CONVERSATION_PRESENTATION_VERSION = 1 as const;

export interface ConversationPresentationRecord {
  readonly version: typeof CONVERSATION_PRESENTATION_VERSION;
  readonly conversationId: string;
  readonly turns: ConversationTurn[];
}

export interface ConversationPresentationStore {
  readVersion?(conversationId: string): Promise<string | null>;
  initialize(): Promise<void>;
  read(conversationId: string): Promise<ConversationPresentationRecord | null>;
  readPage?(conversationId: string, request: ConversationHistoryRequest): Promise<ConversationHistoryPage<ConversationTurn>>;
  upsert?(conversationId: string, turn: ConversationTurn): Promise<void>;
  findMany?(conversationId: string, turnIds: readonly string[]): Promise<ReadonlyMap<string, ConversationTurn>>;
  write(record: ConversationPresentationRecord): Promise<void>;
  delete(conversationId: string): Promise<boolean>;
}

export class FileConversationPresentationStore implements ConversationPresentationStore {
  readonly rootDir: string;
  readonly recordsDir: string;
  readonly quarantineDir: string;

  constructor(rootDir: string, private readonly history?: ConversationHistoryStore<ConversationTurn>,
    private readonly windows?: WindowsPrivateFileRoot) {
    this.rootDir = resolve(rootDir);
    this.recordsDir = join(this.rootDir, 'records');
    this.quarantineDir = join(this.rootDir, 'quarantine');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.recordsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.quarantineDir, { recursive: true, mode: 0o700 }),
    ]);
  }

  async readVersion(conversationId: string): Promise<string | null> {
    this.recordPath(conversationId);
    return this.history?.version(conversationId) ?? null;
  }

  async read(conversationId: string): Promise<ConversationPresentationRecord | null> {
    if (this.history) {
      if (!await this.ensureImported(conversationId)) return null;
      const turns: ConversationTurn[] = [];
      let cursor: string | undefined;
      do {
        const page = this.history.page(conversationId, { limit: 50, cursor });
        turns.unshift(...page.turns);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return { version: 1, conversationId, turns };
    }
    return this.readLegacy(conversationId);
  }

  async readPage(conversationId: string, request: ConversationHistoryRequest): Promise<ConversationHistoryPage<ConversationTurn>> {
    if (this.history) {
      if (!await this.ensureImported(conversationId)) return { turns: [], nextCursor: null };
      return this.history.page(conversationId, request);
    }
    // Isolated legacy consumers do not have the durable index injected.
    const turns = (await this.readLegacy(conversationId))?.turns ?? [];
    const before = request.cursor ? Number(request.cursor) : turns.length;
    if (!Number.isSafeInteger(before) || before < 0) throw new Error('invalid_history_cursor');
    const limit = Math.min(request.limit ?? 10, 50);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_history_limit');
    const start = Math.max(0, before - limit);
    return { turns: turns.slice(start, before), nextCursor: start > 0 ? String(start) : null };
  }

  async upsert(conversationId: string, turn: ConversationTurn): Promise<void> {
    assertRecord({ version: 1, conversationId, turns: [turn] }, conversationId);
    if (this.history) {
      await this.ensureImported(conversationId);
      this.history.importOnce(conversationId, []);
      this.history.upsert(conversationId, turn);
      return;
    }
    const turns = (await this.readLegacy(conversationId))?.turns ?? [];
    const index = turns.findIndex(existing => existing.id === turn.id);
    if (index === -1) turns.push(turn);
    else turns[index] = turn;
    await this.write({ version: 1, conversationId, turns: boundWebSessionTurns(turns) });
  }

  async findMany(conversationId: string, turnIds: readonly string[]): Promise<ReadonlyMap<string, ConversationTurn>> {
    if (this.history) {
      if (!await this.ensureImported(conversationId)) return new Map();
      return this.history.findMany(conversationId, turnIds);
    }
    const ids = new Set(turnIds);
    const record = await this.readLegacy(conversationId);
    return new Map((record?.turns ?? []).filter(turn => ids.has(turn.id)).map(turn => [turn.id, turn]));
  }

  private async ensureImported(conversationId: string): Promise<boolean> {
    this.recordPath(conversationId);
    if (this.history!.isImported(conversationId)) return true;
    const legacy = await this.readLegacy(conversationId);
    if (!legacy) return false;
    // importOnce rechecks inside the transaction after the asynchronous file read.
    this.history!.importOnce(conversationId, legacy?.turns ?? []);
    return true;
  }

  private async readLegacy(conversationId: string): Promise<ConversationPresentationRecord | null> {
    const path = this.recordPath(conversationId);
    try {
      return parseRecord(await readFile(path, 'utf8'), conversationId);
    } catch (error) {
      if (isMissingFile(error)) return null;
      if (error instanceof SyntaxError || (error as Error).message.startsWith('Invalid presentation')) {
        await this.quarantine(path, conversationId, 'invalid');
        return null;
      }
      throw error;
    }
  }

  async write(record: ConversationPresentationRecord): Promise<void> {
    assertRecord(record, record.conversationId);
    if (this.history) {
      await this.ensureImported(record.conversationId);
      this.history.replace(record.conversationId, record.turns);
      return;
    }
    await atomicWriteJson(this.recordPath(record.conversationId), record, this.windows);
  }

  async delete(conversationId: string): Promise<boolean> {
    const path = this.recordPath(conversationId);
    const legacy = await exists(path);
    if (legacy) await this.quarantine(path, conversationId, 'deleted');
    const indexed = this.history?.delete(conversationId) ?? false;
    return legacy || indexed;
  }

  private recordPath(conversationId: string): string {
    if (!isValidConversationId(conversationId)) {
      throw new Error(`Invalid Conversation ID: ${conversationId}`);
    }
    const path = resolve(this.recordsDir, `${conversationId}.json`);
    if (!path.startsWith(`${this.recordsDir}/`)) {
      throw new Error(`Invalid Conversation ID: ${conversationId}`);
    }
    return path;
  }

  private async quarantine(
    path: string,
    conversationId: string,
    reason: 'invalid' | 'deleted',
  ): Promise<void> {
    await mkdir(this.quarantineDir, { recursive: true, mode: 0o700 });
    try {
      await rename(path, join(
        this.quarantineDir,
        `${conversationId}.${Date.now()}.${reason}.json`,
      ));
      await syncDirectory(this.quarantineDir);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

function parseRecord(raw: string, expectedId: string): ConversationPresentationRecord {
  const value = JSON.parse(raw) as unknown;
  assertRecord(value, expectedId);
  return value;
}

function assertRecord(
  value: unknown,
  expectedId: string,
): asserts value is ConversationPresentationRecord {
  if (
    !isRecord(value)
    || value.version !== CONVERSATION_PRESENTATION_VERSION
    || value.conversationId !== expectedId
    || !Array.isArray(value.turns)
    || !value.turns.every(turn => isPresentationTurn(turn, expectedId))
  ) throw new Error(`Invalid presentation record: ${expectedId}`);
}

function isPresentationTurn(value: unknown, conversationId: string): value is ConversationTurn {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.sessionId === conversationId
    && typeof value.userInput === 'string'
    && ['completed', 'failed', 'blocked'].includes(String(value.status))
    && (typeof value.finalAnswer === 'string' || value.finalAnswer === null)
    && (typeof value.taskId === 'string' || value.taskId === null)
    && typeof value.startedAt === 'string'
    && (typeof value.completedAt === 'string' || value.completedAt === null)
    && Array.isArray(value.traceEvents)
    && (isRecord(value.executionTimeline) || value.executionTimeline === null)
    && Array.isArray(value.artifactRefs)
    && Array.isArray(value.artifacts);
}

async function atomicWriteJson(path: string, value: unknown, windows?: WindowsPrivateFileRoot): Promise<void> {
  if (windows) { writeWindowsPrivateJson(windows, path, value); return; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
