import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type RuntimeUpdateLockOwner = 'runtime' | 'update';

export interface RuntimeUpdateLock {
  readonly owner: RuntimeUpdateLockOwner;
  readonly path: string;
  release(): Promise<void>;
}

interface RuntimeUpdateLockRecord {
  readonly schemaVersion: 1;
  readonly owner: RuntimeUpdateLockOwner;
  readonly pid: string;
  readonly token: string;
  readonly startedAt: string;
  readonly acquiredAt: string;
}

export function runtimeUpdateLockPath(installationRoot: string): string {
  return join(installationRoot, 'data', 'runtime.lock');
}

export async function acquireRuntimeUpdateLock(
  installationRoot: string,
  owner: RuntimeUpdateLockOwner,
): Promise<RuntimeUpdateLock> {
  const path = runtimeUpdateLockPath(installationRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const acquiredAt = new Date().toISOString();
  const record: RuntimeUpdateLockRecord = {
    schemaVersion: 1,
    owner,
    pid: String(process.pid),
    token: randomUUID(),
    startedAt: acquiredAt,
    acquiredAt,
  };
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const holder = await readRuntimeUpdateLock(path);
    if (holder && !isProcessAlive(Number(holder.pid))) {
      await rm(path, { force: true });
      return acquireRuntimeUpdateLock(installationRoot, owner);
    }
    throw new Error(
      `${holder?.owner ?? 'unknown owner'} holds the runtime/update lock`
      + `${holder ? ` (PID ${holder.pid})` : ''}`,
    );
  }

  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await handle.close();
  }

  let released = false;
  return {
    owner,
    path,
    async release(): Promise<void> {
      if (released) return;
      const current = await readRuntimeUpdateLock(path);
      if (!current || current.token !== record.token) {
        throw new Error('runtime/update lock ownership changed before release');
      }
      await rm(path, { force: true });
      released = true;
    },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readRuntimeUpdateLock(
  path: string,
): Promise<{
  owner: RuntimeUpdateLockOwner;
  pid: string;
  token: string | null;
} | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const value = JSON.parse(raw) as Partial<RuntimeUpdateLockRecord>;
    const pid = String(value.pid ?? '');
    if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
    const owner = value.owner === 'update' ? 'update' : 'runtime';
    return {
      owner,
      pid,
      token: typeof value.token === 'string' && value.token.length > 0
        ? value.token
        : null,
    };
  } catch {
    return null;
  }
}
