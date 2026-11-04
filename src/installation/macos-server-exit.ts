import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { macOSBackgroundTarget } from './macos-background-process.js';

const execute = promisify(execFile);
interface ServerProcess {
  root: string;
  target: string;
  pid: number;
  identity: string;
}

async function job(target: string): Promise<string | null> {
  try { return (await execute('/bin/launchctl', ['print', target], { timeout: 5_000 })).stdout; }
  catch (error) {
    // launchctl uses 113 for an absent service; other failures must not permit activation.
    if ((error as { code?: number }).code === 113) return null;
    throw error;
  }
}
const jobPid = (value: string | null): number | null => {
  const match = value?.match(/^\s*pid = (\d+)$/mu);
  return match ? Number(match[1]) : null;
};
function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return Boolean(child) && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
async function identity(pid: number): Promise<string | null> {
  try {
    const output = (await execute('/bin/ps', ['-p', String(pid), '-o', 'uid=,lstart=,stat=,command='],
      { timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();
    if (!output) return null;
    const fields = /^(\d+\s+.{24})\s+(\S+)\s+([\s\S]+)$/u.exec(output);
    if (!fields) throw new Error('Unrecognized Server process identity');
    // A killed child can briefly be a zombie before launchd reaps it. Its argv
    // changes to (node); this is not PID reuse. Wait for launchd to retire it.
    return fields[2]!.startsWith('Z') ? null : `${fields[1]} ${fields[3]}`;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return null;
    throw error;
  }
}

/** Capture BEFORE the formal stop: old Servers remove their lock before Node exits. */
export async function captureMacOSServerProcess(installRoot: string): Promise<ServerProcess | null> {
  const root = await realpath(installRoot);
  const target = await macOSBackgroundTarget(root, 'server');
  const description = await job(target);
  const pid = jobPid(description);
  if (!pid) return null;
  const args = description?.match(/^\s*arguments = \{\n([\s\S]*?)^\s*\}/mu)?.[1]
    .trim().split('\n').map(value => value.trim());
  const command = args?.join(' ');
  const processIdentity = await identity(pid);
  if (!processIdentity) return null;
  if (!args || args.length !== 4 || args[2] !== 'server' || args[3] !== 'start'
    || !inside(join(root, 'app/releases'), args[1]!) || !args[1]!.endsWith('/dist/index.js')
    || !(inside(join(root, 'app/releases'), args[0]!) || inside(join(root, 'desktop-support'), args[0]!))
    || !args[0]!.endsWith('/node/bin/node') || pid === process.pid
    || !processIdentity.startsWith(`${process.getuid!()} `) || !processIdentity.endsWith(` ${command}`)) {
    throw new Error('Background Server process identity mismatch');
  }
  return { root, target, pid, identity: processIdentity };
}

/**
 * Force the exit of a captured Server that did not stop on SIGTERM.
 *
 * Two callers exist: the explicit installer/user stop, and `connect()` reclaiming
 * an instance that already withdrew its endpoints but never finished exiting.
 * Neither ever kills a Server that still publishes an endpoint or an instance
 * lock: withdrawal is the proof that the process can no longer admit work.
 */
export async function finishMacOSServerExit(server: ServerProcess, options: {
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: (pid: number, signal: NodeJS.Signals) => unknown;
  /**
   * Reclaim a Server that hung before withdrawing its endpoints.
   *
   * Only the explicit update/repair path sets this: a hung shutdown there blocks
   * the whole upgrade forever, and leaving the machine unusable is worse than a
   * killed drain (writes are WAL-journaled and the identity is re-verified
   * before the kill). Ordinary connect never forces an unwithdrawn Server.
   */
  forceUnwithdrawn?: boolean;
} = {}): Promise<void> {
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const sameProcess = async () => {
    const current = await identity(server.pid);
    const activePid = jobPid(await job(server.target));
    if (!current) return activePid === server.pid;
    // ps and launchd are separate observations. During exit, launchd can drop
    // the PID before ps drops the original argv (or its temporary (node) name).
    // Keep waiting for reaping; never turn this observation into kill authority.
    const stamp = server.identity.match(/^(\d+\s+.{24}) /u)?.[1];
    if ((activePid === null || activePid === server.pid) && current === `${stamp} (node)`) return true;
    if (activePid === null && current === server.identity) return true;
    if (current !== server.identity || activePid !== server.pid) {
      throw new Error('Background Server changed during stop');
    }
    return true;
  };
  const wait = async (ms: number) => {
    for (let remaining = ms; remaining > 0; remaining -= 200) {
      if (!await sameProcess()) return true;
      await sleep(200);
    }
    return !await sameProcess();
  };
  if (await wait(options.timeoutMs ?? 10_000)) return;
  // A missing lock alone is not proof of a completed drain: require withdrawn
  // endpoints, then recheck identity before reclaiming the process.
  const withdrawn = async () => {
    for (const path of ['data/runtime.lock', 'server-endpoint.json']) {
      const exists = await lstat(join(server.root, path)).then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      });
      if (exists) return false;
    }
    return true;
  };
  const assertWithdrawn = async () => {
    if (await withdrawn()) return;
    if (!options.forceUnwithdrawn) throw new Error('Background Server has not completed shutdown');
    console.error(`MetaWork Server PID ${server.pid} did not withdraw its endpoints within the stop window; `
      + 'forced exit will be verified by process identity');
  };
  await assertWithdrawn();
  // Holding descriptors is NOT a reason to leave a zombie behind any more: the
  // endpoints are already withdrawn, so the process cannot admit work, and
  // SQLite is crash-safe in WAL mode. Report what it still holds, then reclaim.
  const held = await heldRuntimeResources(server).catch(() => null);
  if (held === null) return; // process left while we inspected it
  if (held.length > 0) {
    console.error(`MetaWork Server PID ${server.pid} withdrew its endpoints but stayed alive; `
      + `held resources before forced exit: ${held.join(', ')}`);
  }
  await assertWithdrawn();
  if (!await sameProcess()) return;
  if (jobPid(await job(server.target)) !== server.pid) {
    throw new Error('Background Server changed during stop');
  }
  try { (options.signal ?? process.kill.bind(process))(server.pid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  if (!await wait(5_000)) throw new Error('Background Server did not exit after shutdown');
}

/** Descriptors that reveal why a Server could not finish exiting; diagnostics only. */
async function heldRuntimeResources(server: ServerProcess): Promise<string[] | null> {
  const files = await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(server.pid), '-Ftn'],
    { timeout: 5_000 }).then(value => value.stdout, async error => {
      if (!await identity(server.pid)) return null;
      throw error;
    });
  if (files === null) return null;
  if (!files.startsWith(`p${server.pid}\n`)) return ['unexpected lsof output'];
  return files.split('\n').filter(line => /^t(?:IPv4|IPv6|unix)$/u.test(line)
    || (line.startsWith('n')
      && (inside(join(server.root, 'accounts'), line.slice(1)) || inside(join(server.root, 'data'), line.slice(1)))));
}
