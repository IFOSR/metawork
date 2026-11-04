import { execFile } from 'node:child_process';
import { isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export interface ServerProcessScanDeps {
  readonly execute?: typeof execute;
  readonly platform?: NodeJS.Platform;
  /** `null` means the caller has no uid and the scan must not run. */
  readonly uid?: number | null;
  readonly selfPid?: number;
}

/**
 * Find `…/app/releases/<release>/dist/index.js server start` processes owned by
 * this user under one install root.
 *
 * Explicit `--force` recovery only: a Server that is stuck inside the native
 * part of `process.exit` has already deleted its instance lock, so ownership
 * plus argv identity is the last remaining evidence that it belongs to this
 * installation. Anything ambiguous is skipped instead of guessed at.
 */
export async function findInstalledServerProcesses(
  installRoot: string,
  deps: ServerProcessScanDeps = {},
): Promise<number[]> {
  if ((deps.platform ?? process.platform) === 'win32') return [];
  const run = deps.execute ?? execute;
  const uid = deps.uid === undefined ? process.getuid?.() : deps.uid;
  const selfPid = deps.selfPid ?? process.pid;
  // Never fall back to "no uid filter": without an ownership check this scan
  // would be able to kill another user's process.
  if (uid === undefined || uid === null) return [];
  const output = (await run('/bin/ps', ['-Ao', 'pid=,uid=,command='], { timeout: 5_000 })).stdout;
  const releases = `${installRoot.replace(/[\\/]+$/u, '')}/app/releases/`;
  const found: number[] = [];
  for (const line of output.split('\n')) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!fields) continue;
    const pid = Number(fields[1]);
    if (Number(fields[2]) !== uid || pid === selfPid) continue;
    const command = fields[3]!;
    if (!command.includes(releases) || !command.endsWith('/dist/index.js server start')) continue;
    const release = command.slice(command.indexOf(releases) + releases.length, command.indexOf('/dist/index.js server start'));
    if (!release || isAbsolute(release) || relative('.', release).startsWith(`..${sep}`) || release.startsWith('..')) continue;
    found.push(pid);
  }
  return found;
}
