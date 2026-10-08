import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, sep } from 'node:path';

/** OS operations only; each caller retains its existing data schema and lifecycle. */
export interface WindowsPrivateFiles {
  ensurePrivateDirectory(path: string): void;
  readPrivateFile(root: string, relative: string, maximum?: number): Buffer;
  writePrivateFile(root: string, relative: string, data: Buffer, maximum?: number): void;
  createPrivateFile(root: string, relative: string, data: Buffer, maximum?: number): void;
  flushPrivateFile(path: string): void;
  flushPrivateDirectory(path: string): void;
  replacePrivateSymlink(root: string, relative: string, target: string, directory: boolean): void;
  removePrivateFile(root: string, relative: string): void;
  movePrivateEntry(root: string, source: string, destination: string, directory: boolean): void;
  promotePrivateFilePointer(root: string, relative: string, target: string): void;
}

export interface WindowsPrivateFileRoot {
  root: string;
  files: WindowsPrivateFiles;
}

/** Persist the caller's existing JSON schema through the guarded Windows writer. */
export function writeWindowsPrivateJson(windows: WindowsPrivateFileRoot, path: string, value: unknown): void {
  const child = relative(windows.root, path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Private JSON path escapes installation');
  windows.files.ensurePrivateDirectory(dirname(path));
  windows.files.writePrivateFile(windows.root, child,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 9 * 1024 * 1024);
}

export function loadWindowsPrivateFiles(modulePath: string): WindowsPrivateFiles {
  if (process.platform !== 'win32' || !isAbsolute(modulePath)) throw new Error('Absolute Windows platform module required');
  const addon: unknown = createRequire(import.meta.url)(modulePath);
  if (!addon || typeof addon !== 'object' || !['ensurePrivateDirectory', 'readPrivateFile', 'writePrivateFile', 'createPrivateFile', 'flushPrivateFile', 'flushPrivateDirectory', 'replacePrivateSymlink', 'removePrivateFile', 'movePrivateEntry', 'promotePrivateFilePointer']
    .every(name => typeof (addon as Record<string, unknown>)[name] === 'function')) {
    throw new Error('Incompatible Windows private-file adapter');
  }
  return addon as WindowsPrivateFiles;
}
