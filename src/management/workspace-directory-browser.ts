import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { isWithinWorkspaceRoot } from '../workspace/workspace-root.js';

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
  /** 配置的工作目录根；null 表示未限制。 */
  readonly root: string | null;
  readonly nextCursor: string | null;
}

export interface WorkspaceDirectoryBrowserDeps {
  readonly defaultPath?: () => string;
  readonly maxEntries?: number;
  /** 配置的工作目录根；返回 null 表示不限制。 */
  readonly workspaceRoot?: () => string | null;
}

/**
 * 只读目录列举，供未创建的 Workspace 选择使用。
 *
 * 根策略由部署配置决定：未配置 METAWORK_WORKSPACE_ROOT 时根策略为 `/`——允许向上
 * 导航到文件系统根，不排除任何目录，与历史行为一致。配置了根时，浏览起点就是该根，
 * 且不能越过它：根位置不再返回 parent（没有上级目录可回），越界路径直接拒绝。
 *
 * path、parent、crumbs 与 entries 中的每个路径都经过 realpath 归一化，因此符号链接
 * 目录会以其目标目录的规范路径出现——这正是 select_workspace 之后会重新解析并存储
 * 的路径。crumbs 由 Server 生成，客户端不再自行解析操作系统路径，Windows 盘符与
 * 分隔符语义完全留在 Server 侧。
 *
 * 这里只增加“可发现性”，不增加授权能力：select_workspace 本身会独立校验同一边界。
 */
export class WorkspaceDirectoryBrowser {
  private readonly defaultPath: () => string;
  private readonly maxEntries: number;
  private readonly workspaceRoot: () => string | null;

  constructor(deps: WorkspaceDirectoryBrowserDeps = {}) {
    this.defaultPath = deps.defaultPath ?? homedir;
    this.maxEntries = deps.maxEntries ?? MAX_BROWSE_ENTRIES;
    this.workspaceRoot = deps.workspaceRoot ?? (() => null);
  }

  async browse(requestedPath?: string, after?: string): Promise<WorkspaceBrowseResult> {
    const root = this.workspaceRoot();
    const candidate = requestedPath?.trim() || root || this.defaultPath();
    if (!isAbsolute(candidate)) throw new Error('browse_path_invalid');
    const canonical = await resolveCanonical(candidate);
    // 根限制在 realpath 之后判定：符号链接别名与 `..` 拼写无法把候选路径挪出根外。
    if (!isWithinWorkspaceRoot(root, canonical)) throw new Error('browse_path_forbidden');
    const info = await stat(canonical).catch(() => null);
    if (!info) throw new Error('browse_path_not_found');
    if (!info.isDirectory()) throw new Error('browse_path_invalid');
    const dirents = await readdir(canonical, { withFileTypes: true }).catch(error => {
      throw mapReadError(error);
    });
    // 上限在 realpath 之前应用，以便界定每请求的系统调用数量；
    // 因此实际返回条数可能少于 maxEntries。
    const remainingNames = dirents
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .sort(compareNames)
      .filter(name => after === undefined || compareNames(name, after) > 0);
    const names = remainingNames.slice(0, this.maxEntries);
    const entries: WorkspaceBrowseEntry[] = [];
    for (const name of names) {
      const target = await resolveDirectory(resolve(canonical, name));
      if (!target) continue;
      // 根目录内的符号链接若指向根外，列出来也选不中；直接不展示。
      if (!isWithinWorkspaceRoot(root, target)) continue;
      entries.push({ name, path: target });
    }
    return {
      path: canonical,
      // 根目录没有上级可回：这是"不显示返回上级目录"的服务端保证。
      parent: canonical === dirname(canonical)
        ? null
        : isWithinWorkspaceRoot(root, dirname(canonical))
          ? dirname(canonical)
          : null,
      crumbs: buildCrumbs(canonical, root),
      entries,
      root,
      // Advance over inspected names, including broken links, so an empty
      // page never hides later directories or loops on the same cursor.
      nextCursor: remainingNames.length > names.length ? names.at(-1) ?? null : null,
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

function buildCrumbs(canonical: string, root: string | null = null): WorkspaceBrowseCrumb[] {
  // 根限制下，面包屑从根开始：根之上不可导航，因此不出现文件系统根。
  const base = root && isWithinWorkspaceRoot(root, canonical) ? root : parse(canonical).root;
  const crumbs: WorkspaceBrowseCrumb[] = [{ name: base, path: base }];
  for (const segment of canonical.slice(base.length).split(sep).filter(Boolean)) {
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
