import { readdir, lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { hashContent } from '../storage/task-artifact-repo.js';

/** Capture the user's explicitly selected existing project before execution. */
export async function capturePublicProjectBaseline(workspace: string, directory: string): Promise<Record<string, string>> {
  if (!directory || directory.includes('\\') || isAbsolute(directory) || directory.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('现有项目必须是 Workspace 内明确指定的相对目录');
  }
  const root = await realpath(workspace);
  let path = root;
  for (const segment of directory.split('/')) {
    path = join(path, segment);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('现有项目目录不能包含符号链接');
  }
  const project = await realpath(path);
  if (isAbsolute(relative(root, project)) || relative(root, project).startsWith('..')) throw new Error('项目超出 Workspace');
  const baseline: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const file = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('现有项目不能包含符号链接');
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        if (Object.keys(baseline).length >= 2000 || (await lstat(file)).size > 64 * 1024 * 1024) throw new Error('项目快照超过安全上限');
        baseline[relative(project, file)] = hashContent(await readFile(file));
      }
    }
  };
  await walk(project);
  return baseline;
}
