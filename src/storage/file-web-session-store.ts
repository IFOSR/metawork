import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { resolveAnyFusionPaths } from '../installation/paths.js';
import {
  WEB_SESSION_FORMAT_VERSION,
  type ConversationTurn,
  type WebSessionMetadata,
  type WebSessionRecord,
} from '../management/web-session-types.js';

export interface WebSessionCatalogFile {
  version: typeof WEB_SESSION_FORMAT_VERSION;
  sessions: WebSessionMetadata[];
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;

export class FileWebSessionStore {
  readonly rootDir: string;
  readonly catalogPath: string;
  readonly sessionsDir: string;
  readonly quarantineDir: string;

  constructor(
    rootDir = join(resolveAnyFusionPaths().data, 'web-sessions'),
  ) {
    this.rootDir = resolve(rootDir);
    this.catalogPath = join(this.rootDir, 'catalog.json');
    this.sessionsDir = join(this.rootDir, 'sessions');
    this.quarantineDir = join(this.rootDir, 'quarantine');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.sessionsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.quarantineDir, { recursive: true, mode: 0o700 }),
    ]);
    try {
      await this.readCatalog();
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await this.writeCatalog({
        version: WEB_SESSION_FORMAT_VERSION,
        sessions: [],
      });
    }
  }

  async readCatalog(): Promise<WebSessionCatalogFile> {
    const raw = await readFile(this.catalogPath, 'utf8');
    return parseCatalog(raw);
  }

  async writeCatalog(catalog: WebSessionCatalogFile): Promise<void> {
    assertCatalog(catalog);
    await atomicWriteJson(this.catalogPath, catalog);
  }

  async readSession(sessionId: string): Promise<WebSessionRecord | null> {
    const path = this.sessionPath(sessionId);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }

    try {
      return parseSessionRecord(raw, sessionId);
    } catch {
      await this.quarantine(path, sessionId);
      return null;
    }
  }

  async writeSession(record: WebSessionRecord): Promise<void> {
    const path = this.sessionPath(record.session.id);
    assertSessionRecord(record, record.session.id);
    await atomicWriteJson(path, record);
  }

  /** 硬删除：会话文件移入 quarantine（可恢复），再从 catalog 移除条目。 */
  async deleteSession(sessionId: string): Promise<boolean> {
    const path = this.sessionPath(sessionId);
    const existedFile = await exists(path);
    if (existedFile) {
      await this.moveToQuarantine(path, sessionId, 'deleted');
    }

    const catalog = await this.readCatalog();
    const remaining = catalog.sessions.filter(session => session.id !== sessionId);
    if (remaining.length === catalog.sessions.length && !existedFile) {
      return false;
    }
    if (remaining.length !== catalog.sessions.length) {
      await this.writeCatalog({ ...catalog, sessions: remaining });
    }
    return true;
  }

  /** 批量硬删除，保留 exceptId 指向的会话，返回删除数量。 */
  async deleteAllSessions(exceptId?: string): Promise<number> {
    const catalog = await this.readCatalog();
    let deleted = 0;
    for (const session of catalog.sessions) {
      if (exceptId !== undefined && session.id === exceptId) continue;
      if (await this.deleteSession(session.id)) deleted += 1;
    }
    return deleted;
  }

  private sessionPath(sessionId: string): string {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`Invalid Web session ID: ${sessionId}`);
    }
    const path = resolve(this.sessionsDir, `${sessionId}.json`);
    if (!path.startsWith(`${this.sessionsDir}/`)) {
      throw new Error(`Invalid Web session ID: ${sessionId}`);
    }
    return path;
  }

  private async quarantine(path: string, sessionId: string): Promise<void> {
    await this.moveToQuarantine(path, sessionId, 'invalid');
  }

  private async moveToQuarantine(
    path: string,
    sessionId: string,
    reason: 'invalid' | 'deleted',
  ): Promise<void> {
    await mkdir(this.quarantineDir, { recursive: true, mode: 0o700 });
    const destination = join(
      this.quarantineDir,
      `${sessionId}.${Date.now()}.${reason}.json`,
    );
    try {
      await rename(path, destination);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
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

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes, 'utf8');
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

function parseCatalog(raw: string): WebSessionCatalogFile {
  const value = JSON.parse(raw) as unknown;
  assertCatalog(value);
  return value;
}

function parseSessionRecord(raw: string, expectedId: string): WebSessionRecord {
  const value = JSON.parse(raw) as unknown;
  assertSessionRecord(value, expectedId);
  return value;
}

function assertCatalog(value: unknown): asserts value is WebSessionCatalogFile {
  if (!isRecord(value)
    || value.version !== WEB_SESSION_FORMAT_VERSION
    || !Array.isArray(value.sessions)
    || !value.sessions.every(isSessionMetadata)) {
    throw new Error('Invalid Web session catalog');
  }
}

function assertSessionRecord(
  value: unknown,
  expectedId: string,
): asserts value is WebSessionRecord {
  if (!isRecord(value)
    || value.version !== WEB_SESSION_FORMAT_VERSION
    || !isSessionMetadata(value.session)
    || value.session.id !== expectedId
    || !Array.isArray(value.turns)
    || !value.turns.every(turn => isConversationTurn(turn, expectedId))) {
    throw new Error(`Invalid Web session record: ${expectedId}`);
  }
}

function isSessionMetadata(value: unknown): value is WebSessionMetadata {
  return isRecord(value)
    && typeof value.id === 'string'
    && SESSION_ID_PATTERN.test(value.id)
    && typeof value.title === 'string'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && typeof value.active === 'boolean'
    && typeof value.archived === 'boolean';
}

function isConversationTurn(
  value: unknown,
  sessionId: string,
): value is ConversationTurn {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.sessionId === sessionId
    && typeof value.userInput === 'string'
    && ['completed', 'failed', 'blocked'].includes(String(value.status))
    && (typeof value.finalAnswer === 'string' || value.finalAnswer === null)
    && (typeof value.taskId === 'string' || value.taskId === null)
    && typeof value.startedAt === 'string'
    && (typeof value.completedAt === 'string' || value.completedAt === null)
    && Array.isArray(value.traceEvents)
    && (isRecord(value.executionTimeline) || value.executionTimeline === null)
    && Array.isArray(value.artifactRefs)
    && value.artifactRefs.every(item => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
