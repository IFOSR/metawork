import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { acquireRuntimeUpdateLock } from '../../../src/installation/runtime-update-lock.js';

const execute = promisify(execFile);
const directoryKinds = new Set(['workspace_directory_snapshot', 'workspace_conversation_upserted',
  'workspace_conversation_removed', 'workspace_activity_changed', 'workspace_availability_changed']);

async function developmentRoot(root: string): Promise<string> {
  const canonical = await realpath(root);
  const marker = JSON.parse(await readFile(join(canonical, 'desktop-development.json'), 'utf8'));
  if (marker.purpose !== 'isolated-desktop-development'
    || canonical === resolve(process.env.HOME ?? '', '.metawork')) {
    throw new Error('Recovery requires an isolated Desktop development installation');
  }
  return canonical;
}

async function lsof(args: string[]): Promise<string> {
  try { return (await execute('/usr/sbin/lsof', args)).stdout; }
  catch (error) {
    // lsof returns 1 when some of the selected files have no open handles.
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (failure.code === 1 && !failure.stderr?.trim()) return failure.stdout ?? '';
    throw error;
  }
}

/** Detect old Servers even when an earlier release lost runtime.lock. macOS dev only. */
export async function developmentDatabaseHolders(root: string): Promise<number[]> {
  root = await developmentRoot(root);
  const revisions = join(root, 'accounts/local-default/data/database-revisions');
  const files = (await readdir(revisions)).filter(name => name.endsWith('.db')).map(name => join(revisions, name));
  if (!files.length) return [];
  const output = await lsof(['-nP', '-Fpc', '--', ...files]);
  const holders = new Map<number, string>();
  let pid = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('c') && pid) holders.set(pid, line.slice(1));
  }
  const verified: number[] = [];
  for (const [holder, command] of holders) {
    const cwd = await lsof(['-a', '-p', String(holder), '-d', 'cwd', '-Fn']);
    if (!cwd) continue; // Exited since the file query.
    if (holder === process.pid || command !== 'node' || !cwd.split('\n').includes(`n${root}`)) {
      throw new Error(`Development database is open in unverified process ${holder}; close it before refreshing`);
    }
    verified.push(holder);
  }
  return verified;
}

export async function stopDevelopmentDatabaseHolders(root: string): Promise<void> {
  const holders = await developmentDatabaseHolders(root);
  for (const pid of holders) {
    try { process.kill(pid, 'SIGTERM'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
      throw new Error(`无法停止旧开发服务 PID ${pid}。请先退出该进程再重试；未修改数据库或日志。`, { cause: error });
    }
  }
  const deadline = Date.now() + 10_000;
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  // Old exit hooks can still delete locks after closing their database handles.
  while (holders.some(alive)) {
    if (Date.now() >= deadline) throw new Error(`旧开发服务尚未释放数据库（PID ${holders.join(', ')}），已停止升级。`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if ((await developmentDatabaseHolders(root)).length) throw new Error('Another development Server started during shutdown');
}

interface Segment {
  account_id: string;
  conversation_id: string;
  segment_id: string;
  last_sequence: number;
}

/** Explicit offline repair of disposable directory delivery events, never Conversation audit. */
export async function repairDevelopmentDirectoryJournal(root: string): Promise<string | null> {
  root = await developmentRoot(root);
  const lock = await acquireRuntimeUpdateLock(root, 'update');
  try {
    if ((await developmentDatabaseHolders(root)).length) throw new Error('Stop all development Servers before journal repair');
    const data = join(root, 'accounts/local-default/data');
    const events = join(root, 'accounts/local-default/gateway/events');
    const db = new Database(join(data, 'anyfusion.db'), { fileMustExist: true });
    try {
      const missing: Segment[] = [];
      const segments = db.prepare('SELECT account_id, conversation_id, segment_id, last_sequence FROM gateway_journal_segments').all() as Segment[];
      for (const segment of segments) {
        if (segment.account_id !== 'local-default' || !/^[a-zA-Z0-9_-]+$/.test(segment.conversation_id)
          || !/^[a-f0-9-]{36}$/.test(segment.segment_id)) throw new Error('Invalid journal segment identity');
        const path = join(events, segment.account_id, `${segment.conversation_id}.segments`, `${segment.segment_id}.json`);
        try {
          if (!(await lstat(path)).isFile()) throw new Error('Journal body must be a regular file');
          if (segment.conversation_id.startsWith('workspace_directory_')) {
            const body = JSON.parse(await readFile(path, 'utf8')) as Array<{ kind: string; turnId: string | null }>;
            if (!Array.isArray(body) || body.some(event => !directoryKinds.has(event.kind) || event.turnId != null)) {
              throw new Error('Directory stream contains non-directory events; automatic repair refused');
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (!segment.conversation_id.startsWith('workspace_directory_workspace_')) {
            throw new Error('Conversation journal body is missing; restore a verified backup instead');
          }
          missing.push(segment);
        }
      }
      if (!missing.length) return null;
      for (const segment of missing) {
        const state = db.prepare('SELECT snapshot_json FROM gateway_journal_streams WHERE account_id = ? AND conversation_id = ?')
          .get(segment.account_id, segment.conversation_id) as { snapshot_json: string } | undefined;
        if (state?.snapshot_json !== '[]') throw new Error('Unexpected directory snapshot; automatic repair refused');
        for (const table of ['gateway_turn_task_observations', 'gateway_trace_read_events']) {
          if (db.prepare(`SELECT 1 FROM ${table} WHERE account_id = ? AND conversation_id = ? LIMIT 1`)
            .get(segment.account_id, segment.conversation_id)) throw new Error('Directory stream contains audit observations; repair refused');
        }
      }
      const backup = join(data, 'backups', `directory-repair-${Date.now()}-${randomUUID()}`);
      await mkdir(backup, { recursive: true, mode: 0o700 });
      await db.backup(join(backup, 'anyfusion.db'));
      await cp(events, join(backup, 'gateway-events'), { recursive: true });
      // This is forensic evidence of an incomplete journal, not an upgrade companion.
      await writeFile(join(backup, 'repair.json'), JSON.stringify({ version: 1, missing, databasePath: await realpath(join(data, 'anyfusion.db')) }), { mode: 0o600 });
      db.transaction(() => {
        for (const segment of missing) {
          db.prepare('DELETE FROM gateway_journal_event_index WHERE account_id = ? AND conversation_id = ? AND segment_id = ?')
            .run(segment.account_id, segment.conversation_id, segment.segment_id);
          db.prepare('DELETE FROM gateway_journal_segments WHERE account_id = ? AND conversation_id = ? AND segment_id = ?')
            .run(segment.account_id, segment.conversation_id, segment.segment_id);
          // Preserve the head: subsequent events must never reuse client sequence numbers.
          db.prepare('UPDATE gateway_journal_streams SET replay_floor = MAX(replay_floor, ?) WHERE account_id = ? AND conversation_id = ?')
            .run(segment.last_sequence, segment.account_id, segment.conversation_id);
        }
      }).immediate();
      return backup;
    } finally { db.close(); }
  } finally { await lock.release(); }
}
