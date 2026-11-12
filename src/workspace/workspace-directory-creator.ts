// 在允许的工作目录根下创建单级目录。
//
// 约束与 Workspace 选目录共用同一边界：父目录必须在根内，目录名必须是单级合法名。
// 判定一律在 realpath 之后进行：符号链接父目录不能把新建位置挪出根外。
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isWithinWorkspaceRoot } from './workspace-root.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f]/u;
const MAX_DIRECTORY_NAME_LENGTH = 128;

export type WorkspaceDirectoryCreateErrorCode =
  | 'directory_name_invalid'
  | 'directory_parent_invalid'
  | 'directory_parent_not_found'
  | 'directory_exists'
  | 'workspace_outside_root';

export class WorkspaceDirectoryCreateError extends Error {
  constructor(readonly code: WorkspaceDirectoryCreateErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceDirectoryCreateError';
  }
}

export interface WorkspaceDirectoryCreatorDeps {
  /** 配置的工作目录根；null 表示不限制。 */
  readonly workspaceRoot?: string | null;
}

export interface CreatedWorkspaceDirectory {
  readonly name: string;
  readonly path: string;
}

/**
 * 在 parentPath 下创建名为 name 的单级目录，返回其规范路径。
 *
 * 不递归创建：一次调用只产生一个目录，父目录必须已存在。
 */
export async function createWorkspaceDirectory(
  input: { parentPath: string; name: string },
  deps: WorkspaceDirectoryCreatorDeps = {},
): Promise<CreatedWorkspaceDirectory> {
  const name = input.name.trim();
  if (!isValidDirectoryName(name)) {
    throw new WorkspaceDirectoryCreateError(
      'directory_name_invalid',
      `invalid directory name: ${input.name}`,
    );
  }
  if (!isAbsolute(input.parentPath)) {
    throw new WorkspaceDirectoryCreateError(
      'directory_parent_invalid',
      `workspace parent path must be absolute: ${input.parentPath}`,
    );
  }
  const root = deps.workspaceRoot ?? null;
  const parent = await realpath(input.parentPath).catch(() => {
    throw new WorkspaceDirectoryCreateError(
      'directory_parent_not_found',
      `workspace parent directory does not exist: ${input.parentPath}`,
    );
  });
  const parentInfo = await stat(parent).catch(() => null);
  if (!parentInfo?.isDirectory()) {
    throw new WorkspaceDirectoryCreateError(
      'directory_parent_invalid',
      `workspace parent path is not a directory: ${input.parentPath}`,
    );
  }
  if (!isWithinWorkspaceRoot(root, parent)) {
    throw new WorkspaceDirectoryCreateError(
      'workspace_outside_root',
      `workspace parent directory is outside the configured workspace root: ${parent}`,
    );
  }
  const target = resolve(join(parent, name));
  // 名字已是单级合法名，这里再确认一次目标仍在父目录内（防规范化差异）。
  if (!isWithinWorkspaceRoot(root, target) || target === parent) {
    throw new WorkspaceDirectoryCreateError(
      'workspace_outside_root',
      `workspace directory is outside the configured workspace root: ${target}`,
    );
  }
  try {
    await mkdir(target, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkspaceDirectoryCreateError(
        'directory_exists',
        `workspace directory already exists: ${target}`,
      );
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkspaceDirectoryCreateError(
        'directory_parent_not_found',
        `workspace parent directory does not exist: ${parent}`,
      );
    }
    throw error;
  }
  const canonical = await realpath(target).catch(() => target);
  return { name, path: canonical };
}

function isValidDirectoryName(name: string): boolean {
  if (!name || name.length > MAX_DIRECTORY_NAME_LENGTH) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (CONTROL_CHARACTERS.test(name)) return false;
  // 保留名在 Windows 上不可用，跨平台统一拒绝。
  if (/[<>:"|?*]/.test(name)) return false;
  return true;
}
