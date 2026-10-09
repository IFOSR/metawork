import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { resolveMetaWorkPaths } from '../installation/paths.js';

export function executableFile(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
  catch { return false; }
}

/** A managed Pi never falls through to an unrelated user installation when damaged. */
export function resolveExecutorTool(command: string, options: {
  releaseRoot?: string; searchPath?: string; managedPi?: string;
} = {}): string {
  if (isAbsolute(command)) return command;
  if (command.includes('/') || command.includes('\\') || /[\r\n\0]/u.test(command)) return '';
  const releaseRoot = options.releaseRoot ?? resolveMetaWorkPaths().appCurrent;
  if (command === 'pi') {
    const managed = options.managedPi ?? process.env.METAWORK_MANAGED_PI;
    if (managed && isAbsolute(managed)) return managed;
    try {
      const { releaseId } = JSON.parse(readFileSync(join(releaseRoot, 'release-identity.json'), 'utf8'));
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseId)) {
        const recovered = join(resolveMetaWorkPaths().root, 'desktop-support', `${releaseId}.tools`);
        if (existsSync(recovered)) return join(recovered, 'executor/bin/pi');
      }
    } catch { /* Uninstalled/source environments have no managed recovery pointer. */ }
    if (existsSync(join(releaseRoot, 'desktop-tools'))) return join(releaseRoot, 'desktop-tools/executor/bin/pi');
  }
  for (const directory of (options.searchPath ?? process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, command);
    if (executableFile(path)) return path;
  }
  // A stable missing path prevents child PATH changes from silently choosing another tool.
  return join(releaseRoot, '.missing-tools', command);
}
