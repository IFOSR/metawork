import { homedir } from 'os';
import { resolveMetaWorkPaths } from '../installation/paths.js';

export function resolveMetaclawDir(
  envInstallRoot?: string,
  userHome = homedir(),
): string {
  return envInstallRoot === undefined
    ? resolveMetaWorkPaths(undefined, undefined, process.env).data
    : resolveMetaWorkPaths(userHome, envInstallRoot).data;
}
