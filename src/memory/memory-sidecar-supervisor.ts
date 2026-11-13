/**
 * Memory engine supervisor.
 *
 * The engine is a third-party process, so it cannot be asked to exit when
 * MetaWork dies. A Server killed by the shutdown watchdog (`exit-watchdog.ts`)
 * therefore used to leave the engine running with the port and the data
 * directory of a process nobody owned. Memory belongs to MetaWork only, so the
 * engine must never outlive it.
 *
 * The supervisor is a very small Node process that:
 *   - starts the engine with this wrapper's own stdout/stderr (the Server keeps
 *     draining them for redaction/back-pressure safety);
 *   - watches its stdin. The Server holds the write end open and never writes;
 *     when the Server dies for any reason, including SIGKILL, the pipe closes
 *     and this wrapper kills the engine;
 *   - forwards SIGTERM/SIGINT to the engine, so an orderly Server shutdown ends
 *     one process group, not a detached orphan.
 */

import { connect } from 'node:net';

export interface MemorySidecarEngine {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

/** Parent-death supervisor. Kept as source so no build step can miss it. */
export const MEMORY_SIDECAR_SUPERVISOR_SOURCE = `
const { spawn } = require('node:child_process');
const command = process.argv[1];
const args = JSON.parse(process.argv[2] || '[]');
const cwd = process.argv[3] || undefined;
const engine = spawn(command, args, {
  cwd,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: process.env,
});
let stopping = false;
const signal = name => { try { engine.kill(name); } catch {} };
const terminate = () => {
  if (stopping) return;
  stopping = true;
  signal('SIGTERM');
  // An engine that ignores SIGTERM must still not survive this wrapper.
  setTimeout(() => { signal('SIGKILL'); process.exit(0); }, 3000).unref();
};
process.stdin.on('end', terminate);
process.stdin.on('close', terminate);
process.stdin.on('error', terminate);
process.stdin.resume();
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);
engine.on('exit', code => process.exit(typeof code === 'number' ? code : 0));
engine.on('error', () => process.exit(1));
`;

/** Command that runs the given engine under the parent-death supervisor. */
export function memorySidecarSupervisor(engine: MemorySidecarEngine): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      '-e',
      MEMORY_SIDECAR_SUPERVISOR_SOURCE,
      engine.command,
      JSON.stringify(engine.args),
      engine.cwd ?? '',
    ],
  };
}

/**
 * True when something already accepts TCP connections on the endpoint.
 *
 * MetaWork refuses to attach to such an engine: an inherited process carries the
 * configuration of the Server that spawned it, so "healthy" does not mean "the
 * configuration the user just saved".
 */
export function isTcpEndpointListening(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
