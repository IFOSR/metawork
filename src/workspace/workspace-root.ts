// Workspace 根目录（可选限制）。
//
// 部署方可以通过 METAWORK_WORKSPACE_ROOT 指定一个目录，作为用户可浏览、可选择、
// 可新建工作目录的唯一根。未配置时不限制——浏览起点回到 homedir，与历史行为一致。
//
// 根目录在启动期解析一次并 realpath 规范化：此后所有判定都基于规范路径比较，
// 符号链接别名与 `..` 拼写无法绕过边界。
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import {
  PRODUCT_ENVIRONMENT,
  resolveProductEnvironment,
} from '../installation/product-environment.js';

export class WorkspaceRootError extends Error {
  constructor(readonly code: 'not_absolute' | 'not_found' | 'not_directory', message: string) {
    super(message);
    this.name = 'WorkspaceRootError';
  }
}

/** 读取配置的根目录原始值；未配置返回 undefined（不限制）。 */
export function resolveConfiguredWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveProductEnvironment(env, ...PRODUCT_ENVIRONMENT.workspaceRoot);
}

/**
 * 解析并规范化根目录。未配置返回 null（不限制）。
 * 配置了但路径不存在/不是目录/不是绝对路径时抛错——启动期据此失败，
 * 不做静默降级：一个拼错的根路径比"没有限制"更容易解释。
 */
export async function resolveWorkspaceRoot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const configured = resolveConfiguredWorkspaceRoot(env);
  if (!configured) return null;
  if (!isAbsolute(configured)) {
    throw new WorkspaceRootError(
      'not_absolute',
      `${PRODUCT_ENVIRONMENT.workspaceRoot[0]} must be an absolute path: ${configured}`,
    );
  }
  const canonical = await realpath(configured).catch(() => {
    throw new WorkspaceRootError(
      'not_found',
      `${PRODUCT_ENVIRONMENT.workspaceRoot[0]} does not exist: ${configured}`,
    );
  });
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new WorkspaceRootError(
      'not_directory',
      `${PRODUCT_ENVIRONMENT.workspaceRoot[0]} is not a directory: ${configured}`,
    );
  }
  return canonical;
}

/** 候选路径是否位于根目录之内（根自身或其后代）。根为 null 时一律放行。 */
export function isWithinWorkspaceRoot(root: string | null, candidate: string): boolean {
  if (!root) return true;
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
