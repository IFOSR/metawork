import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ConversationTurn } from '../management/web-session-types.js';
import { isValidConversationId } from '../session/conversation-types.js';

export const CONVERSATION_PRESENTATION_VERSION = 1 as const;

export interface ConversationPresentationRecord {
  readonly version: typeof CONVERSATION_PRESENTATION_VERSION;
  readonly conversationId: string;
  readonly turns: ConversationTurn[];
}

export interface ConversationPresentationStore {
  initialize(): Promise<void>;
  read(conversationId: string): Promise<ConversationPresentationRecord | null>;
  write(record: ConversationPresentationRecord): Promise<void>;
  delete(conversationId: string): Promise<boolean>;
}

export class FileConversationPresentationStore implements ConversationPresentationStore {
  readonly rootDir: string;
  readonly recordsDir: string;
  readonly quarantineDir: string;

  constructor(rootDir: string) {
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

  async read(conversationId: string): Promise<ConversationPresentationRecord | null> {
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
    await atomicWriteJson(this.recordPath(record.conversationId), record);
  }

  async delete(conversationId: string): Promise<boolean> {
    const path = this.recordPath(conversationId);
    if (!(await exists(path))) return false;
    await this.quarantine(path, conversationId, 'deleted');
    return true;
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

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
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
