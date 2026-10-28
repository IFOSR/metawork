import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

/**
 * Deterministic launch discovery for a delivered project without a service
 * specification.
 *
 * The Planner decides *which* project the user means; inspecting that project's
 * package scripts, entry files and configuration to find its start command is
 * ordinary engineering detail the Runtime can determine itself. Missing a
 * `.metawork-service.json` must therefore not become a question for the user
 * (2026-10-28 transparent execution §optional service specification).
 *
 * The result is evidence, not a guess: every launch names the file that
 * justified it. Nothing is executed here.
 */

const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_ENTRY_FILES = 24;

/** Ordered by how explicitly a project declares "this starts the service". */
const PACKAGE_SCRIPTS = ['start', 'serve', 'dev', 'preview', 'start:prod'] as const;

const NODE_ENTRY_FILES = [
  'server.js',
  'server.mjs',
  'server.cjs',
  'index.js',
  'index.mjs',
  'app.js',
  'app.mjs',
  'main.js',
  'main.mjs',
] as const;

const PYTHON_ENTRY_FILES = ['server.py', 'app.py', 'main.py'] as const;

export interface DiscoveredLaunchSpecification {
  /** Stable identifier derived from the project, never from the old service. */
  serviceId: string;
  command: string;
  args: string[];
  /** Workspace-relative project directory; `''` is the published root. */
  directory: string;
  /** Human-readable evidence, for diagnostics and operation records. */
  evidence: string;
}

export async function discoverLaunchSpecification(input: {
  /** Canonical published Workspace root. */
  root: string;
  /** Workspace-relative project directory. */
  targetPath: string;
  serviceIdHint?: string;
}): Promise<{ launch: DiscoveredLaunchSpecification | null; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const projectDir = resolve(input.root, input.targetPath);
  const rel = relative(input.root, projectDir);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('/')) {
    return { launch: null, diagnostics: ['目标目录越过已发布的任务目录'] };
  }
  const serviceId = normalizeServiceId(input.serviceIdHint ?? (input.targetPath.split('/').filter(Boolean).at(-1) ?? ''));
  const directory = input.targetPath;

  const packageJsonPath = join(projectDir, 'package.json');
  const packageJson = await readPackageJson(packageJsonPath, diagnostics);
  if (packageJson) {
    const scripts = packageJson.scripts && typeof packageJson.scripts === 'object'
      ? packageJson.scripts as Record<string, unknown>
      : {};
    for (const script of PACKAGE_SCRIPTS) {
      if (typeof scripts[script] !== 'string' || !scripts[script]!.trim()) continue;
      return {
        launch: {
          serviceId,
          command: 'npm',
          args: ['run', script],
          directory,
          evidence: `package.json scripts.${script}`,
        },
        diagnostics,
      };
    }
    const main = typeof packageJson.main === 'string' ? packageJson.main : null;
    if (main && await isFile(join(projectDir, main))) {
      return {
        launch: {
          serviceId,
          command: 'node',
          args: [main],
          directory,
          evidence: 'package.json main',
        },
        diagnostics,
      };
    }
  }

  const entries = (await listEntryFiles(projectDir)).slice(0, MAX_ENTRY_FILES);
  for (const entry of entries) {
    if ((NODE_ENTRY_FILES as readonly string[]).includes(entry)) {
      return {
        launch: {
          serviceId,
          command: 'node',
          args: [entry],
          directory,
          evidence: `entry file ${entry}`,
        },
        diagnostics,
      };
    }
  }
  for (const entry of entries) {
    if ((PYTHON_ENTRY_FILES as readonly string[]).includes(entry)) {
      return {
        launch: {
          serviceId,
          command: 'python3',
          args: [entry],
          directory,
          evidence: `entry file ${entry}`,
        },
        diagnostics,
      };
    }
  }
  if (!packageJson) diagnostics.push('没有可用的 package.json 或入口文件，无法确定启动方式');
  return { launch: null, diagnostics };
}

/** Project-derived service id; unknown characters are not identity. */
export function normalizeServiceId(value: string): string {
  const normalized = (value.split('/').filter(Boolean).at(-1) ?? value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 100);
  return normalized || 'local-service';
}

async function readPackageJson(
  path: string,
  diagnostics: string[],
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_PACKAGE_JSON_BYTES) {
      diagnostics.push('package.json 无效或过大，已忽略');
      return null;
    }
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    diagnostics.push('package.json 无法解析，已忽略');
    return null;
  }
}

async function listEntryFiles(projectDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of [...NODE_ENTRY_FILES, ...PYTHON_ENTRY_FILES]) {
    if (await isFile(join(projectDir, name))) found.push(name);
  }
  return found;
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}
