import { readdir, lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, sep } from 'node:path';
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

const MAX_TARGET_PATHS = 50;

/**
 * Admission-time baseline for the Workspace-relative paths a Task is authorized
 * to touch (2026-10-25 design §6/§9).
 *
 * Publication compares the target file against this snapshot: a file that still
 * matches the admission state may be replaced by the authorized change set, while
 * a file the user edited after admission is reported as a conflict instead of
 * being overwritten. Missing files are omitted: publication treats an absent
 * baseline entry as a path that did not exist at admission and therefore detects
 * a new user file as a conflict before writing the candidate.
 */
export async function captureWorkspaceTargetBaseline(
  workspace: string,
  targetPaths: readonly string[],
): Promise<Record<string, string>> {
  const unique = [...new Set(targetPaths)];
  if (unique.length > MAX_TARGET_PATHS) {
    throw new Error(`Workspace target baseline exceeds ${MAX_TARGET_PATHS} paths`);
  }
  if (unique.length === 0) return {};
  const root = await realpath(workspace);
  const baseline: Record<string, string> = {};
  let fileCount = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Workspace target cannot contain a symbolic link');
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      if (fileCount > 2000) throw new Error('Workspace target baseline exceeds the file limit');
      const info = await lstat(absolute);
      if (info.size > 64 * 1024 * 1024) throw new Error('Workspace target baseline contains an oversized file');
      const relativePath = relative(root, absolute).split(sep).join('/');
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error('Workspace target baseline escaped its root');
      }
      baseline[relativePath] = hashContent(await readFile(absolute));
    }
  };
  for (const relativePath of unique) {
    if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\\')) continue;
    const segments = relativePath.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) continue;
    let current = root;
    let unsafe = false;
    for (const segment of segments) {
      current = join(current, segment);
      if ((await lstat(current).catch(() => null))?.isSymbolicLink()) {
        unsafe = true;
        break;
      }
    }
    if (unsafe) continue;
    const info = await lstat(current).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      await walk(current);
      continue;
    }
    if (!info.isFile() || info.size > 64 * 1024 * 1024) continue;
    const relativePathFromRoot = relative(root, current);
    if (isAbsolute(relativePathFromRoot) || relativePathFromRoot.startsWith('..')) continue;
    baseline[relativePathFromRoot.split(sep).join('/')] = hashContent(await readFile(current));
  }
  return baseline;
}
