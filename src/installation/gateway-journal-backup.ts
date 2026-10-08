import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { WindowsPrivateFileRoot } from '../platform/windows-private-files.js';
import { isValidAccountId } from '../account/account-id.js';
import { isValidConversationId } from '../session/conversation-types.js';

export interface GatewayJournalBackupInput {
  readonly databasePath: string;
  readonly journalRoot: string;
  readonly backupRoot: string;
  readonly windows?: WindowsPrivateFileRoot;
}

interface SegmentIdentity {
  readonly accountId: string;
  readonly conversationId: string;
  readonly segmentId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly byteLength: number;
  readonly path: string;
}

interface Manifest {
  readonly version: 1;
  readonly databasePath: string;
  readonly journalRoot: string;
  readonly segments: readonly (SegmentIdentity & { readonly sha256: string })[];
}

type SourceIndex = Omit<Manifest, 'segments'> & { readonly segments: readonly SegmentIdentity[] };

/** Caller holds the runtime/update lock with Server quiesced. Never writes SQLite. */
export async function backupGatewayJournal(input: GatewayJournalBackupInput): Promise<void> {
  const windows = input.windows;
  const source = await readIndex(input);
  if (!source) return;
  if (await exists(input.backupRoot)) {
    await verifyCompanion(input.backupRoot, source, windows);
    await syncDirectory(dirname(input.backupRoot), windows);
    return;
  }
  await ensureDirectory(dirname(input.backupRoot), windows);
  const staging = `${input.backupRoot}.pending-${randomUUID()}`;
  await ensureDirectory(staging, windows);
  try {
    const segments: Manifest['segments'][number][] = [];
    for (const segment of source.segments) {
      const body = await readBody(input.journalRoot, segment, windows);
      await ensureRelativeDirectories(staging, segment.path, windows);
      await writeDurable(join(staging, segment.path), body, windows);
      segments.push({ ...segment, sha256: hash(body) });
    }
    const manifest = Buffer.from(`${JSON.stringify({ ...source, segments })}\n`);
    await writeDurable(join(staging, 'manifest.json'), manifest, windows);
    await writeDurable(join(staging, 'complete.json'), Buffer.from(`${JSON.stringify({
      version: 1, manifestSha256: hash(manifest),
    })}\n`), windows);
    // Publish only after all bodies, directory entries and the completion marker are durable.
    if (windows) windows.files.movePrivateEntry(windows.root, relative(windows.root, staging), relative(windows.root, input.backupRoot), true);
    else await rename(staging, input.backupRoot);
    await syncDirectory(dirname(input.backupRoot), windows);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Point-in-time restore: retain all current bodies and never overwrite conflicts. */
export async function restoreGatewayJournal(input: GatewayJournalBackupInput): Promise<void> {
  const windows = input.windows;
  const source = await readIndex(input);
  if (!source) return;
  const manifest = await verifyCompanion(input.backupRoot, source, windows);
  // Preflight every destination as well, before publishing any missing body.
  for (const segment of manifest.segments) {
    await verifyExisting(input.journalRoot, segment, windows);
  }
  for (const segment of manifest.segments) {
    if (await verifyExisting(input.journalRoot, segment, windows)) {
      await syncDirectory(dirname(join(input.journalRoot, segment.path)), windows);
      continue;
    }
    const body = await readBody(input.backupRoot, segment, windows);
    await ensureRelativeDirectories(input.journalRoot, segment.path, windows);
    const destination = join(input.journalRoot, segment.path);
    if (windows) {
      try { windows.files.createPrivateFile(windows.root, relative(windows.root, destination), body, 9 * 1024 * 1024); }
      catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
        await readBody(input.journalRoot, segment, windows);
        await syncDirectory(dirname(destination), windows);
      }
      continue;
    }
    const temporary = join(dirname(destination), `${randomUUID()}.json.pending`);
    try {
      await writeDurable(temporary, body);
      try {
        // Unlike rename, link publishes atomically without replacing an existing file.
        await link(temporary, destination);
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
        await readBody(input.journalRoot, segment, windows);
      }
      await syncDirectory(dirname(destination));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function readIndex(input: GatewayJournalBackupInput): Promise<SourceIndex | null> {
  const databasePath = await realpath(input.databasePath);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gateway_journal_segments'").get()) {
      return null;
    }
    const rows = db.prepare(`
      SELECT account_id AS accountId, conversation_id AS conversationId, segment_id AS segmentId,
        first_sequence AS firstSequence, last_sequence AS lastSequence, byte_length AS byteLength
      FROM gateway_journal_segments ORDER BY account_id, conversation_id, segment_id
    `).all() as Omit<SegmentIdentity, 'path'>[];
    const segments = rows.map(row => {
      if (typeof row.accountId !== 'string' || !isValidAccountId(row.accountId)
        || typeof row.conversationId !== 'string' || !isValidConversationId(row.conversationId)
        || typeof row.segmentId !== 'string' || !/^[a-f0-9-]{36}$/.test(row.segmentId)
        || !Number.isSafeInteger(row.byteLength) || row.byteLength <= 0
        || !Number.isSafeInteger(row.firstSequence) || row.firstSequence <= 0
        || !Number.isSafeInteger(row.lastSequence) || row.lastSequence < row.firstSequence) {
        throw new Error('invalid_gateway_journal_segment_identity');
      }
      return {
        ...row, path: `${row.accountId}/${row.conversationId}.segments/${row.segmentId}.json`,
      };
    });
    return { version: 1, databasePath, journalRoot: resolve(input.journalRoot), segments };
  } finally {
    db.close();
  }
}

async function verifyCompanion(backupRoot: string, source: SourceIndex, windows?: WindowsPrivateFileRoot): Promise<Manifest> {
  await assertDirectory(backupRoot);
  const marker = JSON.parse((await readRegular(join(backupRoot, 'complete.json'), undefined, windows)).toString()) as {
    version?: unknown; manifestSha256?: unknown;
  };
  const bytes = await readRegular(join(backupRoot, 'manifest.json'), undefined, windows);
  if (marker?.version !== 1 || marker.manifestSha256 !== hash(bytes)) {
    throw new Error('invalid_gateway_journal_backup_marker');
  }
  const manifest = JSON.parse(bytes.toString()) as Manifest;
  if (!manifest || manifest.version !== 1 || manifest.databasePath !== source.databasePath
    || manifest.journalRoot !== source.journalRoot || !Array.isArray(manifest.segments)
    || manifest.segments.length !== source.segments.length) {
    throw new Error('gateway_journal_backup_identity_mismatch');
  }
  for (let i = 0; i < source.segments.length; i++) {
    const expected = source.segments[i]!;
    const actual = manifest.segments[i];
    if (!actual || typeof actual.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(actual.sha256)
      || Object.entries(expected).some(([key, value]) => actual[key as keyof SegmentIdentity] !== value)) {
      throw new Error('gateway_journal_backup_index_mismatch');
    }
    await readBody(backupRoot, actual, windows);
  }
  return manifest;
}

async function readBody(root: string, segment: SegmentIdentity & { readonly sha256?: string }, windows?: WindowsPrivateFileRoot): Promise<Buffer> {
  await assertRelativeDirectories(root, segment.path);
  const body = await readRegular(join(root, segment.path), segment.byteLength, windows);
  if (segment.sha256 && hash(body) !== segment.sha256) throw new Error('gateway_journal_body_hash_mismatch');
  const events: unknown = JSON.parse(body.toString());
  if (!Array.isArray(events) || !events.length
    || events[0]?.sequence !== segment.firstSequence || events.at(-1)?.sequence !== segment.lastSequence
    || events.some((event, i) => !event || event.accountId !== segment.accountId
      || event.conversationId !== segment.conversationId || !Number.isSafeInteger(event.sequence)
      || (i > 0 && event.sequence <= events[i - 1].sequence))) {
    throw new Error('gateway_journal_body_identity_mismatch');
  }
  return body;
}

async function verifyExisting(root: string, segment: Manifest['segments'][number], windows?: WindowsPrivateFileRoot): Promise<boolean> {
  try {
    await readBody(root, segment, windows);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function readRegular(path: string, byteLength?: number, windows?: WindowsPrivateFileRoot): Promise<Buffer> {
  if (windows) {
    const body = windows.files.readPrivateFile(windows.root, relative(windows.root, path), 9 * 1024 * 1024);
    if (byteLength !== undefined && body.length !== byteLength) throw new Error('gateway_journal_body_length_mismatch');
    return body;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (byteLength !== undefined && info.size !== byteLength)) {
      throw new Error('gateway_journal_body_length_mismatch');
    }
    const body = await handle.readFile();
    if (byteLength !== undefined && body.length !== byteLength) throw new Error('gateway_journal_body_length_mismatch');
    return body;
  } finally {
    await handle.close();
  }
}

async function writeDurable(path: string, bytes: Buffer, windows?: WindowsPrivateFileRoot): Promise<void> {
  if (windows) {
    windows.files.createPrivateFile(windows.root, relative(windows.root, path), bytes, 9 * 1024 * 1024);
    return;
  }
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(dirname(path), windows);
}

async function assertDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error('unsafe_gateway_journal_directory');
}

async function ensureDirectory(path: string, windows?: WindowsPrivateFileRoot): Promise<void> {
  if (windows) {
    windows.files.ensurePrivateDirectory(path);
    windows.files.flushPrivateDirectory(path);
    windows.files.flushPrivateDirectory(dirname(path));
    return;
  }
  try { await assertDirectory(path); }
  catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    await ensureDirectory(dirname(path), windows);
    await mkdir(path, { mode: 0o700 });
  }
  // Also sync parents on retries: a prior interruption may have preceded their fsync.
  await syncDirectory(dirname(path), windows);
}

async function assertRelativeDirectories(root: string, path: string): Promise<void> {
  await assertDirectory(root);
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    await assertDirectory(current);
  }
}

async function ensureRelativeDirectories(root: string, path: string, windows?: WindowsPrivateFileRoot): Promise<void> {
  await ensureDirectory(root, windows);
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    await ensureDirectory(current, windows);
  }
}

async function syncDirectory(path: string, windows?: WindowsPrivateFileRoot): Promise<void> {
  if (windows) { windows.files.flushPrivateDirectory(path); return; }
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}
