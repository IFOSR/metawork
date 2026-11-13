import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { resolveMetaWorkPaths } from '../installation/paths.js';

export function executableFile(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
  catch { return false; }
}

/** Windows resolves bare tool names through PATHEXT-style suffixes; the bare
 *  name itself is the POSIX script shipped for cross-platform tools and can
 *  never be executed directly, so suffixed candidates must win. `X_OK` cannot
 *  filter there (it is an existence check). */
function executableCandidates(path: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32' || /\.[A-Za-z0-9]+$/u.test(path)) return [path];
  return [`${path}.exe`, `${path}.cmd`, `${path}.bat`, path];
}

function firstExisting(path: string, platform: NodeJS.Platform): string {
  return executableCandidates(path, platform).find(candidate => existsSync(candidate)) ?? path;
}

/** A managed Pi never falls through to an unrelated user installation when damaged. */
export function resolveExecutorTool(command: string, options: {
  releaseRoot?: string; searchPath?: string; managedPi?: string; platform?: NodeJS.Platform;
} = {}): string {
  const platform = options.platform ?? process.platform;
  if (isAbsolute(command)) return command;
  if (command.includes('/') || command.includes('\\') || /[\r\n\0]/u.test(command)) return '';
  const releaseRoot = options.releaseRoot ?? resolveMetaWorkPaths().appCurrent;
  if (command === 'pi') {
    const managed = options.managedPi ?? process.env.METAWORK_MANAGED_PI;
    if (managed && isAbsolute(managed)) {
      if (existsSync(managed)) return managed;
      return firstExisting(managed, platform);
    }
    try {
      const { releaseId } = JSON.parse(readFileSync(join(releaseRoot, 'release-identity.json'), 'utf8'));
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseId)) {
        const recovered = join(resolveMetaWorkPaths().root, 'desktop-support', `${releaseId}.tools`);
        if (existsSync(recovered)) return firstExisting(join(recovered, 'executor/bin/pi'), platform);
      }
    } catch { /* Uninstalled/source environments have no managed recovery pointer. */ }
    if (existsSync(join(releaseRoot, 'desktop-tools'))) {
      return firstExisting(join(releaseRoot, 'desktop-tools/executor/bin/pi'), platform);
    }
    // An incomplete installation is an error, not permission to run a user's
    // global Pi with an unrelated version and extensions.
    return join(releaseRoot, '.missing-tools', 'pi');

  }
  for (const directory of (options.searchPath ?? process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = executableCandidates(join(directory, command), platform).find(executableFile);
    if (candidate) return candidate;
  }
  // A stable missing path prevents child PATH changes from silently choosing another tool.
  return join(releaseRoot, '.missing-tools', command);
}
