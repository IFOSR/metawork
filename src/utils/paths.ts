import { homedir } from 'os';
import { resolveAnyFusionPaths } from '../installation/paths.js';

export function resolveMetaclawDir(
  envAnyFusionInstallRoot = process.env.ANYFUSION_INSTALL_ROOT,
  userHome = homedir(),
): string {
  return resolveAnyFusionPaths(userHome, envAnyFusionInstallRoot).data;
}
