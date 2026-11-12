import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';

export type LocalEndpointKind = 'unix' | 'named-pipe';

export function localEndpointKind(platform = process.platform): LocalEndpointKind {
  return platform === 'win32' ? 'named-pipe' : 'unix';
}

export function resolveLocalEndpointPath(
  baseDirectory: string,
  name: string,
  platform = process.platform,
): string {
  if (localEndpointKind(platform) === 'unix') {
    return resolve(baseDirectory, name);
  }
  const identity = createHash('sha256')
    .update(`${resolve(baseDirectory)}\0${name}`)
    .digest('hex')
    .slice(0, 20);
  return `\\\\.\\pipe\\metawork-${name.replace(/[^A-Za-z0-9_.-]/gu, '-')}-${identity}`;
}

export function isNamedPipePath(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\');
}

/** A named pipe has no filesystem listing and a unix socket path may be a
 *  stale file, so endpoint readiness is only meaningful as a successful
 *  connection. */
export function probeLocalEndpoint(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    const socket = createConnection(socketPath);
    let settled = false;
    const settle = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(ready);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    setTimeout(() => settle(false), timeoutMs).unref();
  });
}
