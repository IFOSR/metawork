import { open, readFile, unlink } from 'node:fs/promises';

export interface InstanceLock {
  release(): Promise<void>;
}

interface LockRecord {
  pid: string;
  startedAt: string;
}

/**
 * 取 composition 实例锁。O_EXCL 创建锁文件；失败时按 PID 存活探测回收 stale lock。
 * 本地单用户场景接受 PID 复用竞态（锁内 PID 被无关进程占用会误判存活），
 * 锁文件同时写入启动时间戳供人工排查。
 */
export async function acquireInstanceLock(lockPath: string): Promise<InstanceLock> {
  const content = lockContent();

  if (await tryAcquire(lockPath, content)) {
    return makeLock(lockPath);
  }

  if (await tryReclaimStale(lockPath)) {
    if (await tryAcquire(lockPath, content)) {
      return makeLock(lockPath);
    }
  }

  const holder = await readLock(lockPath);
  throw new Error(`AnyFusion 已在运行（PID ${holder.pid}）`);
}

async function tryAcquire(lockPath: string, content: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  return true;
}

async function tryReclaimStale(lockPath: string): Promise<boolean> {
  const record = await readLock(lockPath);
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return false; // 存活
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; // EPERM 等，保守不回收
  }

  await unlink(lockPath).catch(() => undefined);
  return true;
}

async function readLock(lockPath: string): Promise<LockRecord> {
  const raw = await readFile(lockPath, 'utf8').catch(() => '');
  try {
    const parsed = JSON.parse(raw.trim()) as LockRecord;
    return { pid: parsed.pid || 'unknown', startedAt: parsed.startedAt || '' };
  } catch {
    return { pid: raw.trim() || 'unknown', startedAt: '' };
  }
}

function lockContent(): string {
  return `${JSON.stringify({ pid: String(process.pid), startedAt: new Date().toISOString() })}\n`;
}

function makeLock(lockPath: string): InstanceLock {
  return {
    async release() {
      await unlink(lockPath).catch(() => undefined);
    },
  };
}
