import { lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export function windowsLocalAppData(userHome: string, env: NodeJS.ProcessEnv): string {
  const local = Object.entries(env).find(([key]) => key.toUpperCase() === 'LOCALAPPDATA')?.[1]?.trim();
  if (local && !isAbsolute(local)) throw new Error('LOCALAPPDATA must be an absolute path');
  return local || resolve(userHome, 'AppData', 'Local');
}

/** Only selects a root. Installation/security adapters validate its contents before use. */
export function resolveWindowsDefaultInstallationRoot(userHome: string, env: NodeJS.ProcessEnv): string {
  const current = resolve(windowsLocalAppData(userHome, env), 'MetaWork');
  const legacy = resolve(userHome, '.metawork');
  const currentExists = installationDirectoryExists(current);
  const legacyExists = installationDirectoryExists(legacy);
  if (currentExists && legacyExists) {
    throw new Error('Both Windows MetaWork installation roots exist. Set METAWORK_INSTALL_ROOT explicitly; automatic migration or merging is not supported.');
  }
  return legacyExists ? legacy : current;
}

function installationDirectoryExists(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`MetaWork installation root must be a directory without a reparse link: ${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
