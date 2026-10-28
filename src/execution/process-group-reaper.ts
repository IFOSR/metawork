/**
 * POSIX process-group ownership for one Attempt.
 *
 * An Attempt's Executor CLI is spawned as a process-group leader, so every
 * command, browser, watcher or helper it starts stays in that group even after
 * the leader exits (process-group membership is independent of parenthood).
 * Attempt cancellation already reaps the group; this module gives the *normal*
 * settlement path the same guarantee, because an Attempt must not end while
 * processes it started are still running (2026-10-28 transparent execution
 * §execution-fact contract: the Runtime owns the process, not just the CLI).
 *
 * Only facts safe for diagnostics leave this module: a pid and the executable
 * basename. Command lines, arguments and environment are never recorded.
 */

import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_RECORDED_MEMBERS = 20;
const MAX_COMMAND_LENGTH = 64;
// A background owner task must not be stopped by test frameworks that patch
// global timers, so the real implementations are captured at module load.
const realSetTimeout: typeof setTimeout = setTimeout;
const realNow: () => number = Date.now;

/** Real wall-clock time for recording when a process group was created. */
export function processGroupOwnershipNow(): number {
  return realNow();
}

/** Parse `ps -o etime=` (`[[dd-]hh:]mm:ss`) into seconds. */
function parseElapsedSeconds(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(value.trim());
  if (!match) return null;
  const [days, hours, minutes, seconds] = [
    Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3]), Number(match[4]),
  ];
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

export interface ResidualProcessFact {
  pid: number;
  /** Executable basename only; arguments are deliberately not recorded. */
  command: string;
}

export interface ProcessGroupReapResult {
  pgid: number;
  /** Group members observed before signalling (bounded). */
  members: ResidualProcessFact[];
  signalled: 'none' | 'SIGTERM' | 'SIGKILL';
  /** The group is gone when the reap finished. */
  reaped: boolean;
  durationMs: number;
}

export interface ProcessGroupReaperDeps {
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  listMembers?: (pgid: number, options: { sinceMs?: number }) => Promise<ResidualProcessFact[]>;
  /** Wall-clock time the group was created; members older than it are not ours. */
  sinceMs?: number;
  /** Grace between SIGTERM and SIGKILL. */
  graceMs?: number;
  /** How long to keep waiting after SIGKILL. */
  killWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** True while at least one member of the group is alive. */
export function processGroupAlive(
  pgid: number,
  kill: (pid: number, signal: NodeJS.Signals | 0) => void = process.kill,
): boolean {
  try {
    kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * List live members of one group. `ps` is the portable way to do this on macOS
 * and Linux without inventing a native dependency; failure yields an empty list
 * because the signal outcome, not the inventory, is the authority.
 */
export async function listProcessGroupMembers(
  pgid: number,
  options: { sinceMs?: number } = {},
): Promise<ResidualProcessFact[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pgid=,etime=,comm='], {
      maxBuffer: 4 * 1024 * 1024,
    });
    // A process group id can be reused after its leader dies. Only members
    // younger than the Attempt can be the Attempt's own descendants, so an
    // unrelated group that happens to own the same id is never signalled.
    const maxAgeSeconds = options.sinceMs === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.ceil((realNow() - options.sinceMs) / 1_000) + 1);
    const members: ResidualProcessFact[] = [];
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
      if (!match || Number(match[2]) !== pgid) continue;
      const pid = Number(match[1]);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const age = parseElapsedSeconds(match[3]!);
      if (age === null || age > maxAgeSeconds) continue;
      members.push({
        pid,
        command: basename(match[4]!.trim()).slice(0, MAX_COMMAND_LENGTH),
      });
      if (members.length >= MAX_RECORDED_MEMBERS) break;
    }
    return members;
  } catch {
    return [];
  }
}

/**
 * Reap everything still running in `pgid`: SIGTERM, bounded grace, then SIGKILL.
 *
 * Returns immediately without signalling when the group is already empty, which
 * is the normal case for an Attempt that cleaned up after itself.
 */
export async function reapProcessGroup(
  input: { pgid: number | null; reason?: string } & ProcessGroupReaperDeps,
): Promise<ProcessGroupReapResult> {
  const startedAt = (input.now ?? realNow)();
  const kill = input.kill ?? process.kill;
  const graceMs = input.graceMs ?? 1_000;
  const killWaitMs = input.killWaitMs ?? 500;
  const pollMs = input.pollMs ?? 50;
  const sleep = input.sleep ?? (ms => new Promise(resolve => realSetTimeout(resolve, ms)));
  const pgid = input.pgid;
  const empty: ProcessGroupReapResult = {
    pgid: pgid ?? -1,
    members: [],
    signalled: 'none',
    reaped: true,
    durationMs: 0,
  };
  // `kill(-1, …)` would signal every process the caller may target, so an
  // unusable group id is never treated as "the group".
  if (!pgid || pgid <= 1 || pgid === process.pid) return empty;

  // Never signal a group id we cannot attribute. Enumerating first also avoids
  // a PID/PGID reuse race (a dead Attempt's group id could belong to an
  // unrelated process by now) and keeps fake/unknown ids inert.
  const listMembers = input.listMembers ?? listProcessGroupMembers;
  const members = await listMembers(pgid, { sinceMs: input.sinceMs });
  if (members.length === 0) return empty;
  const signal = (name: NodeJS.Signals) => {
    try {
      kill(-pgid, name);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  };
  const waitGone = async (deadlineMs: number): Promise<boolean> => {
    while ((input.now ?? realNow)() < deadlineMs) {
      if (!processGroupAlive(pgid, kill)) return true;
      await sleep(pollMs);
    }
    return !processGroupAlive(pgid, kill);
  };

  let signalled: ProcessGroupReapResult['signalled'] = 'none';
  if (signal('SIGTERM')) signalled = 'SIGTERM';
  let reaped = await waitGone((input.now ?? realNow)() + graceMs);
  if (!reaped) {
    if (signal('SIGKILL')) signalled = 'SIGKILL';
    reaped = await waitGone((input.now ?? realNow)() + killWaitMs);
  }
  return {
    pgid,
    members,
    signalled,
    reaped,
    durationMs: (input.now ?? realNow)() - startedAt,
  };
}
