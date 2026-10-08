import { open, readFile, unlink } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface InstanceLock {
  release(): Promise<void>;
  releaseOnExit(): void;
}

export interface StopInstanceForRestartResult {
  status: 'stopped' | 'not_running';
  pid?: number;
}

export async function isInstanceRunning(
  lockPath: string,
  signalProcess: (pid: number, signal: NodeJS.Signals | 0) => boolean = process.kill.bind(process),
): Promise<boolean> {
  const holder = await readLockIfPresent(lockPath);
  if (!holder) return false;

  const pid = Number(holder.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`MetaWork 运行锁中的 PID 无效: ${holder.pid}`);
  }
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

interface StopInstanceForRestartOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => boolean;
  sleep?: (durationMs: number) => Promise<void>;
  /** Windows must request the formal Server drain; SIGTERM is TerminateProcess. */
  requestStop?: (pid: number) => Promise<void>;
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
    return makeLock(lockPath, content);
  }

  if (await tryReclaimStale(lockPath)) {
    if (await tryAcquire(lockPath, content)) {
      return makeLock(lockPath, content);
    }
  }

  const holder = await readLock(lockPath);
  throw new Error(`MetaWork 已在运行（PID ${holder.pid}）`);
}

export async function stopInstanceForRestart(
  lockPath: string,
  options: StopInstanceForRestartOptions = {},
): Promise<StopInstanceForRestartResult> {
  const holder = await readLockIfPresent(lockPath);
  if (!holder) return { status: 'not_running' };

  const pid = Number(holder.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`MetaWork 运行锁中的 PID 无效: ${holder.pid}`);
  }
  if (pid === process.pid) {
    throw new Error('MetaWork 拒绝重启当前进程自身');
  }

  const signalProcess = options.signalProcess ?? process.kill.bind(process);
  if (!isProcessAlive(pid, signalProcess)) {
    return { status: 'not_running', pid };
  }

  try {
    if (options.requestStop) await options.requestStop(pid);
    else {
      if (process.platform === 'win32') throw new Error('Windows Server stop requires authenticated lifecycle control');
      signalProcess(pid, 'SIGTERM');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return { status: 'stopped', pid };
    }
    throw error;
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  const sleep = options.sleep ?? (durationMs => new Promise(resolve => setTimeout(resolve, durationMs)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(pollIntervalMs);
    if (!isProcessAlive(pid, signalProcess)) {
      return { status: 'stopped', pid };
    }
  }

  throw new Error(`MetaWork 进程 PID ${pid} 未在 ${timeoutMs}ms 内退出`);
}

function removeInstanceLockOnExit(lockPath: string, expectedContent: string): void {
  try {
    if (readFileSync(lockPath, 'utf8') === expectedContent) unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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
  return (await readLockIfPresent(lockPath)) ?? { pid: 'unknown', startedAt: '' };
}

async function readLockIfPresent(lockPath: string): Promise<LockRecord | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw.trim()) as LockRecord;
    return { pid: parsed.pid || 'unknown', startedAt: parsed.startedAt || '' };
  } catch {
    return { pid: raw.trim() || 'unknown', startedAt: '' };
  }
}

function isProcessAlive(
  pid: number,
  signalProcess: (pid: number, signal: NodeJS.Signals | 0) => boolean,
): boolean {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function lockContent(): string {
  return `${JSON.stringify({ pid: String(process.pid), startedAt: new Date().toISOString(), token: randomUUID() })}\n`;
}

function makeLock(lockPath: string, content: string): InstanceLock {
  let released = false;
  const release = () => {
    if (released) return;
    // Synchronous compare/unlink also prevents two releases from interleaving
    // with a new acquisition in this process. A previous Server never owns a
    // replacement Server/update lock, including a new lock with the same PID.
    removeInstanceLockOnExit(lockPath, content);
    released = true;
  };
  return {
    async release() {
      release();
    },
    releaseOnExit: release,
  };
}
