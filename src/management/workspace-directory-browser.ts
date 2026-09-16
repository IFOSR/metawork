import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

export const MAX_BROWSE_ENTRIES = 500;

export interface WorkspaceBrowseEntry {
  readonly name: string;
  readonly path: string;
}

export interface WorkspaceBrowseCrumb {
  readonly name: string;
  readonly path: string;
}

export interface WorkspaceBrowseResult {
  readonly path: string;
  readonly parent: string | null;
  readonly crumbs: WorkspaceBrowseCrumb[];
  readonly entries: WorkspaceBrowseEntry[];
}

export interface WorkspaceDirectoryBrowserDeps {
  readonly defaultPath?: () => string;
  readonly maxEntries?: number;
}

/**
 * 只读目录列举，供未创建的 Workspace 选择使用。
 *
 * 根策略为 `/`：允许向上导航到文件系统根，不排除任何目录。path、parent、crumbs
 * 与 entries 中的每个路径都经过 realpath 归一化，因此符号链接目录会以其目标目录
 * 的规范路径出现——这正是 select_workspace 之后会重新解析并存储的路径。crumbs 由
 * Server 生成，客户端不再自行解析操作系统路径，Windows 盘符与分隔符语义完全留在
 * Server 侧。
 *
 * 这里只增加“可发现性”，不增加授权能力：select_workspace 本来就接受任意存在的
 * 绝对目录。
 */
export class WorkspaceDirectoryBrowser {
  private readonly defaultPath: () => string;
  private readonly maxEntries: number;

  constructor(deps: WorkspaceDirectoryBrowserDeps = {}) {
    this.defaultPath = deps.defaultPath ?? homedir;
    this.maxEntries = deps.maxEntries ?? MAX_BROWSE_ENTRIES;
  }

  async browse(requestedPath?: string): Promise<WorkspaceBrowseResult> {
    const candidate = requestedPath?.trim() || this.defaultPath();
    if (!isAbsolute(candidate)) throw new Error('browse_path_invalid');
    const canonical = await resolveCanonical(candidate);
    const info = await stat(canonical).catch(() => null);
    if (!info) throw new Error('browse_path_not_found');
    if (!info.isDirectory()) throw new Error('browse_path_invalid');
    const dirents = await readdir(canonical, { withFileTypes: true }).catch(error => {
      throw mapReadError(error);
    });
    // 上限在 realpath 之前应用，以便界定每请求的系统调用数量；
    // 因此实际返回条数可能少于 maxEntries。
    const names = dirents
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .sort(compareNames)
      .slice(0, this.maxEntries);
    const entries: WorkspaceBrowseEntry[] = [];
    for (const name of names) {
      const target = await resolveDirectory(resolve(canonical, name));
      if (!target) continue;
      entries.push({ name, path: target });
    }
    return {
      path: canonical,
      parent: canonical === dirname(canonical) ? null : dirname(canonical),
      crumbs: buildCrumbs(canonical),
      entries,
    };
  }
}

/** 解析为目录时返回规范路径；指向文件或已消失时返回 null。 */
async function resolveDirectory(path: string): Promise<string | null> {
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function buildCrumbs(canonical: string): WorkspaceBrowseCrumb[] {
  const root = parse(canonical).root;
  const crumbs: WorkspaceBrowseCrumb[] = [{ name: root, path: root }];
  for (const segment of canonical.slice(root.length).split(sep).filter(Boolean)) {
    crumbs.push({
      name: segment,
      path: join(crumbs[crumbs.length - 1]!.path, segment),
    });
  }
  return crumbs;
}

async function resolveCanonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw mapReadError(error);
  }
}

function mapReadError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new Error('browse_path_not_found');
  if (code === 'EACCES' || code === 'EPERM') return new Error('browse_path_forbidden');
  return new Error('browse_path_invalid');
}

function compareNames(left: string, right: string): number {
  const normalized = left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
  return normalized !== 0 ? normalized : left.localeCompare(right);
}
