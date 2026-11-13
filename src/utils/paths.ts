import { homedir } from 'os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveMetaWorkPaths } from '../installation/paths.js';

export function resolveMetaclawDir(
  envInstallRoot?: string,
  userHome = homedir(),
): string {
  return envInstallRoot === undefined
    ? resolveMetaWorkPaths(undefined, undefined, process.env).data
    : resolveMetaWorkPaths(userHome, envInstallRoot).data;
}

/** Containment for platform-native path derivations: both inputs go through
 *  resolve(), so the comparison is separator- and platform-correct. */
export function isPathInsideDirectory(childPath: string, directory: string): boolean {
  const childPathResolved = resolve(childPath);
  const directoryResolved = resolve(directory);
  const pathRelative = relative(directoryResolved, childPathResolved);
  return pathRelative !== ''
    && !pathRelative.startsWith(`..${sep}`)
    && pathRelative !== '..'
    && !isAbsolute(pathRelative);
}
