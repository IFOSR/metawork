import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { rm, lstat } from 'node:fs/promises';

const execute = promisify(execFile);
export interface PublicFileChange { path: string; source: string | null; executable: boolean }

/** An isolated index builds a controlled branch; merge updates the actual user tree. */
export async function publishPublicGitChanges(workspace: string, taskId: string, changes: PublicFileChange[]): Promise<boolean> {
  const git = async (args: string[], env?: NodeJS.ProcessEnv) => (await execute('git', ['-C', workspace, ...args], {
    env: env ?? process.env, maxBuffer: 4 * 1024 * 1024,
  })).stdout.trim();
  let cursor = workspace;
  while (!await lstat(join(cursor, '.git')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw new Error('无法检查 Git Workspace');
  })) {
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  let root: string;
  try { root = await git(['rev-parse', '--show-toplevel']); }
  catch { throw new Error('Git Workspace 无效，无法安全发布'); }
  if (await git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('发布冲突：Git Workspace 有未提交修改，请先保存后重试');
  const index = join(tmpdir(), `metawork-public-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'MetaWork', GIT_AUTHOR_EMAIL: 'runtime@metawork.local',
    GIT_COMMITTER_NAME: 'MetaWork', GIT_COMMITTER_EMAIL: 'runtime@metawork.local' };
  try {
    const base = await git(['rev-parse', '--verify', 'HEAD']).catch(() => null);
    await git(base ? ['read-tree', base] : ['read-tree', '--empty'], env);
    for (const change of changes) {
      const path = relative(root, change.path);
      if (change.source) {
        const object = await git(['hash-object', '-w', '--', change.source]);
        await git(['update-index', '--add', '--cacheinfo', change.executable ? '100755' : '100644', object, path], env);
      } else await git(['update-index', '--force-remove', '--', path], env);
    }
    const tree = await git(['write-tree'], env);
    if (base && tree === await git(['rev-parse', `${base}^{tree}`])) return true;
    const commit = await git(['commit-tree', tree, ...(base ? ['-p', base] : []), '-m', 'feat: deliver MetaWork task files'], env);
    const branch = `refs/heads/metawork/task-${createHash('sha256').update(taskId).digest('hex').slice(0, 20)}`;
    await git(['update-ref', branch, commit]);
    // Recheck immediately before Git's index/worktree transaction.
    if (await git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('发布冲突：Git Workspace 在发布时发生修改');
    await git(['merge', '--ff-only', '--no-edit', commit]);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('发布冲突')) throw error;
    // Child-process exceptions contain internal staging paths; never project them.
    throw new Error('Git 任务分支发布失败，请检查 Workspace 状态后重试');
  } finally { await rm(index, { force: true }); }
}
