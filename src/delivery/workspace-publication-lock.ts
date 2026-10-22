import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, lstat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pending = new Map<string, Promise<unknown>>();

/** Serialize public-tree and Git-index transactions, including other Servers. */
export async function withWorkspacePublicationLock<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
  const previous = pending.get(workspace) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const key = createHash('sha256').update(workspace).digest('hex');
    const lock = join(tmpdir(), `metawork-publication-${key}.lock`);
    const deadline = Date.now() + 60_000;
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        await writeFile(join(lock, 'owner'), String(process.pid), { mode: 0o600 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = Number(await readFile(join(lock, 'owner'), 'utf8').catch(() => '0'));
        let alive = owner > 0;
        try { if (alive) process.kill(owner, 0); } catch { alive = false; }
        const stat = await lstat(lock).catch(() => null);
        if (!stat) continue;
        if (!alive && Date.now() - stat.mtimeMs > 1000) {
          const abandoned = `${lock}.${randomUUID()}`;
          try { await rename(lock, abandoned); await rm(abandoned, { recursive: true, force: true }); } catch { /* Another waiter reclaimed it. */ }
          continue;
        }
        if (Date.now() >= deadline) throw new Error('Workspace 正在交付其他文件，请稍后重试');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
  });
  pending.set(workspace, next);
  try { return await next; } finally { if (pending.get(workspace) === next) pending.delete(workspace); }
}
