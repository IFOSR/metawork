/**
 * Conversation 文件存储（ADR-0031 第 9 节）。
 *
 * 账户作用域的 Conversation 记录存储，使用原子写入、
 * 无效记录隔离（quarantine）与 ID 校验模式。目录结构：
 *
 * <conversationsRoot>/
 *   catalog.json
 *   records/<conversationId>.json
 *   quarantine/
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { measureNavigationStage } from '../utils/navigation-diagnostics.js';
import { writeWindowsPrivateJson, type WindowsPrivateFileRoot } from '../platform/windows-private-files.js';
import { isValidConversationId } from './conversation-types.js';
import type { ConversationHistoryStore, ConversationHistoryRequest } from './conversation-history-store.js';
import {
  CONVERSATION_FORMAT_VERSION,
  type ConversationCatalogFile,
  type ConversationMetadata,
  type ConversationMetadataIndex,
  type ConversationRecord,
  type ConversationStore,
  type ConversationTurn,
} from './conversation-store.js';

const PLANNER_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const recordOperations = new Map<string, Promise<unknown>>();

export class FileConversationStore implements ConversationStore {
  readonly rootDir: string;
  readonly catalogPath: string;
  readonly recordsDir: string;
  readonly quarantineDir: string;

  constructor(rootDir: string, private readonly options: {
    readonly windows?: WindowsPrivateFileRoot;
    readonly onMetadataCommitted?: (metadata: ConversationMetadata) => void;
    readonly history?: ConversationHistoryStore<ConversationTurn>;
    readonly metadataIndex?: ConversationMetadataIndex;
    /** One-time legacy presentation backfill; never called on an indexed page. */
    readonly readLegacyHistory?: (conversationId: string) => Promise<readonly ConversationTurn[]>;
  } = {}) {
    this.rootDir = resolve(rootDir);
    this.catalogPath = join(this.rootDir, 'catalog.json');
    this.recordsDir = join(this.rootDir, 'records');
    this.quarantineDir = join(this.rootDir, 'quarantine');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.recordsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.quarantineDir, { recursive: true, mode: 0o700 }),
    ]);
    try {
      await this.readCatalog();
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await this.writeCatalog({
        version: CONVERSATION_FORMAT_VERSION,
        conversations: [],
      });
    }
  }

  async readCatalog(): Promise<ConversationCatalogFile> {
    return measureNavigationStage('catalog_read', async () => {
      const raw = await readFile(this.catalogPath, 'utf8');
      return parseCatalog(raw);
    });
  }

  async writeCatalog(catalog: ConversationCatalogFile): Promise<void> {
    assertCatalog(catalog);
    await atomicWriteJson(this.catalogPath, catalog, this.options.windows);
  }

  async readConversation(conversationId: string): Promise<ConversationRecord | null> {
    return this.serialized(conversationId, async () => {
      await this.recoverPendingHistory(conversationId);
      return this.readRecord(conversationId);
    });
  }

  async readMetadata(conversationId: string): Promise<ConversationMetadata | null> {
    return this.serialized(conversationId, async () => {
      await this.recoverPendingHistory(conversationId);
      const existing = this.options.metadataIndex?.find(conversationId);
      if (existing) return existing;
      const record = await this.readRecord(conversationId);
      if (record) this.options.metadataIndex?.put(record.conversation);
      return record?.conversation ?? null;
    });
  }

  async readHistoryVersion(conversationId: string): Promise<string | null> {
    return this.serialized(conversationId, async () => {
      await this.recoverPendingHistory(conversationId);
      return this.options.history?.version(conversationId) ?? null;
    });
  }

  async updateMetadata(
    conversationId: string,
    update: (metadata: ConversationMetadata) => ConversationMetadata,
  ): Promise<ConversationMetadata | null> {
    return this.serialized(conversationId, async () => {
      await this.recoverPendingHistory(conversationId);
      const record = await this.readRecord(conversationId);
      if (!record) return null;
      const metadata = update(record.conversation);
      const updated = { ...record, conversation: metadata };
      assertRecord(updated, conversationId);
      if (JSON.stringify(metadata) === JSON.stringify(record.conversation)) return metadata;
      await atomicWriteJson(this.recordPath(conversationId), updated, this.options.windows);
      this.options.metadataIndex?.put(metadata);
      this.options.onMetadataCommitted?.(metadata);
      return metadata;
    });
  }

  private async readRecord(conversationId: string): Promise<ConversationRecord | null> {
    const path = this.recordPath(conversationId);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    try {
      return parseRecord(raw, conversationId);
    } catch {
      await this.quarantine(path, conversationId);
      return null;
    }
  }

  async writeConversation(record: ConversationRecord): Promise<void> {
    const path = this.recordPath(record.conversation.id);
    assertRecord(record, record.conversation.id);
    await this.serialized(record.conversation.id, async () => {
      await this.recoverPendingHistory(record.conversation.id);
      const history = this.options.history;
      if (!history) {
        await atomicWriteJson(path, record, this.options.windows);
        this.options.metadataIndex?.put(record.conversation);
        this.options.onMetadataCommitted?.(record.conversation);
        return;
      }
      if (!history.isImported(record.conversation.id)) {
        const previous = await this.readRecord(record.conversation.id);
        if (!previous && record.turns.length === 0) {
          // First creation has no old indexed state to protect. The atomic
          // record itself recovers missing indexes if initialization is interrupted.
          await atomicWriteJson(path, record, this.options.windows);
          await this.importHistory(record.conversation.id, []);
          this.options.metadataIndex?.put(record.conversation);
          this.options.onMetadataCommitted?.(record.conversation);
          return;
        }
        await this.importHistory(record.conversation.id, previous?.turns ?? []);
      }
      // A durable write intent closes the JSON/index crash window. Recovery
      // repeats this exact write before serving either the record or its pages.
      await atomicWriteJson(`${path}.pending-history`, record, this.options.windows);
      await this.recoverPendingHistory(record.conversation.id);
    });
  }

  async readHistoryPage(conversationId: string, request: ConversationHistoryRequest = {}) {
    this.recordPath(conversationId);
    const history = this.options.history;
    if (!history) {
      const record = await this.readConversation(conversationId);
      if (!record) throw new Error('conversation_not_found');
      const before = request.cursor ? Number(request.cursor) : record.turns.length;
      const limit = request.limit ?? 10;
      if (!Number.isSafeInteger(before) || before < 0) throw new Error('invalid_history_cursor');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid_history_limit');
      const start = Math.max(0, before - limit);
      return { turns: record.turns.slice(start, before), nextCursor: start > 0 ? String(start) : null };
    }
    return this.serialized(conversationId, async () => {
      await this.recoverPendingHistory(conversationId);
      if (!history.isImported(conversationId)) {
        const record = await this.readRecord(conversationId);
        if (!record) throw new Error('conversation_not_found');
        await this.importHistory(conversationId, record.turns);
      }
      return history.page(conversationId, request);
    });
  }

  private async importHistory(conversationId: string, canonical: readonly ConversationTurn[]): Promise<void> {
    const history = this.options.history!;
    if (history.isImported(conversationId)) return;
    const legacy = await this.options.readLegacyHistory?.(conversationId) ?? [];
    // Canonical order wins for shared IDs. Rich-only runs are placed before
    // their next shared anchor, never dropped because the rolling basic file
    // has already evicted them. With no anchors the legacy archive precedes it.
    const canonicalIds = new Set(canonical.map(turn => turn.id));
    const before = new Map<string, ConversationTurn[]>();
    let pending: ConversationTurn[] = [];
    let anchored = false;
    const seen = new Set<string>();
    for (const turn of legacy) {
      if (turn.conversationId !== conversationId || seen.has(turn.id)) continue;
      seen.add(turn.id);
      if (canonicalIds.has(turn.id)) {
        before.set(turn.id, pending);
        pending = [];
        anchored = true;
      } else pending.push(turn);
    }
    const merged = canonical.flatMap(turn => [...(before.get(turn.id) ?? []), turn]);
    history.importOnce(conversationId, anchored ? [...merged, ...pending] : [...pending, ...merged]);
  }

  private async recoverPendingHistory(conversationId: string): Promise<void> {
    const history = this.options.history;
    if (!history) return;
    const path = this.recordPath(conversationId);
    let raw: string;
    try { raw = await readFile(`${path}.pending-history`, 'utf8'); }
    catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    const record = parseRecord(raw, conversationId);
    await atomicWriteJson(path, record, this.options.windows);
    await this.importHistory(conversationId, record.turns);
    for (const turn of record.turns) history.upsert(conversationId, turn);
    this.options.metadataIndex?.put(record.conversation);
    await unlink(`${path}.pending-history`);
    this.options.onMetadataCommitted?.(record.conversation);
  }

  private serialized<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const key = this.recordPath(conversationId);
    const pending = (recordOperations.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    recordOperations.set(key, pending);
    return pending.finally(() => {
      if (recordOperations.get(key) === pending) recordOperations.delete(key);
    });
  }

  private recordPath(conversationId: string): string {
    if (!isValidConversationId(conversationId)) {
      throw new Error(`Invalid conversation id: ${conversationId}`);
    }
    const path = resolve(this.recordsDir, `${conversationId}.json`);
    if (!path.startsWith(`${this.recordsDir}${sep}`)) {
      throw new Error(`Invalid conversation id: ${conversationId}`);
    }
    return path;
  }

  private async quarantine(path: string, conversationId: string): Promise<void> {
    await mkdir(this.quarantineDir, { recursive: true, mode: 0o700 });
    const destination = join(
      this.quarantineDir,
      `${conversationId}.${Date.now()}.invalid.json`,
    );
    try {
      await rename(path, destination);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

async function atomicWriteJson(path: string, value: unknown, windows?: WindowsPrivateFileRoot): Promise<void> {
  if (windows) { writeWindowsPrivateJson(windows, path, value); return; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseCatalog(raw: string): ConversationCatalogFile {
  const value = JSON.parse(raw) as unknown;
  return normalizeCatalog(value);
}

function parseRecord(raw: string, expectedId: string): ConversationRecord {
  const value = JSON.parse(raw) as unknown;
  return normalizeRecord(value, expectedId);
}

function assertCatalog(value: unknown): asserts value is ConversationCatalogFile {
  if (!isRecord(value)
    || value.version !== CONVERSATION_FORMAT_VERSION
    || !Array.isArray(value.conversations)
    || !value.conversations.every(isMetadata)) {
    throw new Error('Invalid conversation catalog');
  }
}

function normalizeCatalog(value: unknown): ConversationCatalogFile {
  if (!isRecord(value) || !Array.isArray(value.conversations)) {
    throw new Error('Invalid conversation catalog');
  }
  if (value.version !== CONVERSATION_FORMAT_VERSION) {
    throw new Error('Invalid conversation catalog');
  }
  const conversations = value.conversations.map(item => normalizeMetadata(item));
  if (conversations.some(item => item === null)) {
    throw new Error('Invalid conversation catalog');
  }
  return {
    version: CONVERSATION_FORMAT_VERSION,
    conversations: conversations as ConversationMetadata[],
  };
}

function assertRecord(value: unknown, expectedId: string): asserts value is ConversationRecord {
  if (!isRecord(value)) throw new Error(`Invalid conversation record: ${expectedId}`);
  if (value.version !== CONVERSATION_FORMAT_VERSION) throw new Error(`Invalid conversation record: ${expectedId}`);
  const conversation = value.conversation;
  if (!isMetadata(conversation)) throw new Error(`Invalid conversation record: ${expectedId}`);
  if (conversation.id !== expectedId) throw new Error(`Invalid conversation record: ${expectedId}`);
  const turns = value.turns;
  if (!Array.isArray(turns)) throw new Error(`Invalid conversation record: ${expectedId}`);
  if (!turns.every(turn => isTurn(turn, expectedId))) {
    throw new Error(`Invalid conversation record: ${expectedId}`);
  }
}

function normalizeRecord(value: unknown, expectedId: string): ConversationRecord {
  if (!isRecord(value) || !Array.isArray(value.turns)) {
    throw new Error(`Invalid conversation record: ${expectedId}`);
  }
  if (value.version !== CONVERSATION_FORMAT_VERSION) {
    throw new Error(`Invalid conversation record: ${expectedId}`);
  }
  const conversation = normalizeMetadata(value.conversation);
  if (!conversation || conversation.id !== expectedId) {
    throw new Error(`Invalid conversation record: ${expectedId}`);
  }
  const turns = value.turns;
  if (!turns.every(turn => isTurn(turn, expectedId))) {
    throw new Error(`Invalid conversation record: ${expectedId}`);
  }
  return {
    version: CONVERSATION_FORMAT_VERSION,
    conversation,
    turns: turns as ConversationTurn[],
  };
}

function isMetadata(value: unknown): value is ConversationMetadata {
  return normalizeMetadata(value) !== null;
}

function normalizeMetadata(value: unknown): ConversationMetadata | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !isValidConversationId(value.id)) return null;
  if (typeof value.plannerSessionId !== 'string'
    || !PLANNER_SESSION_ID_PATTERN.test(value.plannerSessionId)) return null;
  if (typeof value.accountId !== 'string'
    || !ACCOUNT_ID_PATTERN.test(value.accountId)) return null;
  if (typeof value.title !== 'string') return null;
  if (typeof value.createdAt !== 'string') return null;
  if (typeof value.updatedAt !== 'string') return null;
  if (typeof value.archived !== 'boolean') return null;
  const workspaceBinding = value.workspaceBinding === undefined
    ? null
    : parseWorkspaceBinding(value.workspaceBinding);
  if (workspaceBinding === undefined) return null;
  if ('workspace' in value) return null;
  return {
    id: value.id,
    plannerSessionId: value.plannerSessionId,
    accountId: value.accountId,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archived: value.archived,
    workspaceBinding,
  };
}

function parseWorkspaceBinding(
  value: unknown,
): ConversationMetadata['workspaceBinding'] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (
    typeof value.workspaceId !== 'string'
    || typeof value.boundAt !== 'string'
    || typeof value.boundByPrincipal !== 'string'
  ) {
    return undefined;
  }
  return {
    workspaceId: value.workspaceId,
    boundAt: value.boundAt,
    boundByPrincipal: value.boundByPrincipal,
  };
}

function isTurn(value: unknown, conversationId: string): value is ConversationTurn {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (value.conversationId !== conversationId) return false;
  if (typeof value.userInput !== 'string') return false;
  if (value.finalAnswer !== null && typeof value.finalAnswer !== 'string') return false;
  if (!['completed', 'failed', 'blocked'].includes(String(value.status))) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
