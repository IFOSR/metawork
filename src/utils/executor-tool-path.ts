import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveMetaWorkPaths } from '../installation/paths.js';

/**
 * Windows resolves a command name through PATHEXT, so `pi` is normally
 * `pi.exe`, `pi.cmd` or `pi.bat`. The bare name frequently exists as well:
 * npm writes a POSIX `sh` shim named exactly `pi` next to `pi.cmd`, and
 * `CreateProcess` cannot start it. Preferring a real image and then a script
 * shim keeps the resolved entry runnable instead of merely present.
 */
const WINDOWS_IMAGE_SUFFIXES = ['.exe', '.com'] as const;
const WINDOWS_SCRIPT_SUFFIXES = ['.cmd', '.bat'] as const;
/** Entries Windows cannot execute directly; they run through the Node runtime. */
const WINDOWS_SCRIPT_ENTRY_SUFFIXES = ['.js', '.mjs', '.cjs'] as const;

export interface ExecutorToolOptions {
  releaseRoot?: string;
  searchPath?: string;
  managedPi?: string;
}

/**
 * A resolved local CLI launch. `prefixArgs` carries the tool's own entry when
 * the resolved path is a script shim that must be started through its Node
 * entry instead of through `cmd.exe`.
 */
export interface ExecutorLaunch {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly shellShim: boolean;
}

export function executableFile(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
  catch { return false; }
}

/**
 * Candidate paths for one command in one directory, in resolution order. On
 * POSIX this is exactly the bare name; on Windows a real image wins over a
 * script shim, and a PE image may legitimately carry no extension.
 */
export function commandCandidates(directory: string, command: string): string[] {
  if (process.platform !== 'win32') return [join(directory, command)];
  return [
    ...WINDOWS_IMAGE_SUFFIXES.map(suffix => join(directory, `${command}${suffix}`)),
    ...WINDOWS_SCRIPT_SUFFIXES.map(suffix => join(directory, `${command}${suffix}`)),
    join(directory, command),
  ];
}

/** First runnable candidate for `command` inside `directory`, if any. */
export function resolveCommandInDirectory(directory: string, command: string): string | null {
  for (const candidate of commandCandidates(directory, command)) {
    if (executableFile(candidate)) return candidate;
  }
  return null;
}

/** A managed Pi never falls through to an unrelated user installation when damaged. */
export function resolveExecutorTool(command: string, options: ExecutorToolOptions = {}): string {
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
    const resolved = resolveCommandInDirectory(directory, command);
    if (resolved !== null) return resolved;
  }
  // A stable missing path prevents child PATH changes from silently choosing another tool.
  return join(releaseRoot, '.missing-tools', command);
}

/**
 * Resolve the executable and any entry argument needed to actually start the
 * tool. Script shims are opened through their Node entry so no shell parses the
 * attempt's argv; `shellShim` means no entry could be recovered and only a
 * short probe may safely fall back to `cmd.exe`.
 */
export function resolveExecutorLaunch(
  command: string,
  options: ExecutorToolOptions = {},
): ExecutorLaunch {
  const resolved = isAbsolute(command) ? command : resolveExecutorTool(command, options);
  if (process.platform !== 'win32' || resolved === '') {
    return { executable: resolved, prefixArgs: [], shellShim: false };
  }
  if (!existsSync(resolved)) {
    // The fail-closed missing path stays a plain path so probes report ENOENT
    // ("command not found") instead of a shell's "path not found".
    return { executable: resolved, prefixArgs: [], shellShim: false };
  }
  const lowered = resolved.toLowerCase();
  if (WINDOWS_SCRIPT_ENTRY_SUFFIXES.some(suffix => lowered.endsWith(suffix))) {
    // Windows cannot execute a `.js` entry directly (no shebang support): it
    // fails with EFTYPE, so a Node entry always runs through the Node runtime.
    return { executable: process.execPath, prefixArgs: [resolved], shellShim: false };
  }
  if (WINDOWS_IMAGE_SUFFIXES.some(suffix => lowered.endsWith(suffix)) || isWindowsImage(resolved)) {
    return { executable: resolved, prefixArgs: [], shellShim: false };
  }
  const entry = windowsScriptEntry(resolved);
  if (entry !== null) return { executable: process.execPath, prefixArgs: [entry], shellShim: false };
  return {
    executable: process.env.ComSpec?.trim() || 'cmd.exe',
    prefixArgs: ['/d', '/s', '/c', resolved],
    shellShim: true,
  };
}

/** Build an argv for a resolved launch, prepending the shim's own entry. */
export function executorLaunchArgv(
  launch: ExecutorLaunch,
  args: readonly string[],
): { command: string; args: string[] } {
  return { command: launch.executable, args: [...launch.prefixArgs, ...args] };
}

function isWindowsImage(path: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const header = Buffer.alloc(2);
    const read = readSync(descriptor, header, 0, 2, 0);
    return read === 2 && header[0] === 0x4d && header[1] === 0x5a;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * npm's Windows shims (`pi.cmd`, and the `sh` shim named `pi`) both spell out
 * the package's JS entry relative to the shim directory. Recovering that entry
 * lets the executor run `node <entry>` directly.
 */
function windowsScriptEntry(shimPath: string): string | null {
  let source: string;
  try {
    source = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const directory = dirname(shimPath);
  const seen = new Set<string>();
  for (const match of source.matchAll(/(?:%dp0%|\$basedir|basedir)[\\/]([^"'\s]+\.(?:js|mjs|cjs))/giu)) {
    const relative = match[1]!.replaceAll('\\', '/').replace(/^\/+/u, '');
    const candidate = resolve(directory, relative);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isReadableFile(candidate)) return candidate;
  }
  return null;
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
