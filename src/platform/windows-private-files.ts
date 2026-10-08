import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

/** OS operations only; each caller retains its existing data schema and lifecycle. */
export interface WindowsPrivateFiles {
  ensurePrivateDirectory(path: string): void;
  readPrivateFile(root: string, relative: string, maximum?: number): Buffer;
  writePrivateFile(root: string, relative: string, data: Buffer, maximum?: number): void;
}

export function loadWindowsPrivateFiles(modulePath: string): WindowsPrivateFiles {
  if (process.platform !== 'win32' || !isAbsolute(modulePath)) throw new Error('Absolute Windows platform module required');
  const addon: unknown = createRequire(import.meta.url)(modulePath);
  if (!addon || typeof addon !== 'object' || !['ensurePrivateDirectory', 'readPrivateFile', 'writePrivateFile']
    .every(name => typeof (addon as Record<string, unknown>)[name] === 'function')) {
    throw new Error('Incompatible Windows private-file adapter');
  }
  return addon as WindowsPrivateFiles;
}
