import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import {
  readEndpointManifest,
  validateEndpointManifest,
  type EndpointManifest,
} from '../server/server-endpoint-manifest.js';

export interface ClientEndpoint {
  readonly ok: true;
  readonly manifestVersion: number;
  readonly socketPath: string;
  readonly webOrigin: string;
  readonly serverVersion?: string;
}

export interface ClientEndpointError {
  readonly ok: false;
  readonly code: 'server_unavailable' | 'protocol_mismatch' | 'server_draining' | 'invalid_manifest';
  readonly message: string;
}

export type ClientEndpointResult = ClientEndpoint | ClientEndpointError;

export interface ClientEndpointResolverDeps {
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly socketExists?: (path: string) => boolean;
  readonly socketProbe?: (path: string) => Promise<void>;
}

export async function resolveClientEndpoint(
  manifestPath: string,
  protocolVersion: number,
  deps: ClientEndpointResolverDeps = {},
): Promise<ClientEndpointResult> {
  let manifest: EndpointManifest | null;
  try {
    manifest = await readEndpointManifest(manifestPath);
  } catch {
    return unavailable();
  }
  if (!manifest) return unavailable();

  const validation = validateEndpointManifest(manifest, {
    protocolVersion,
    isProcessAlive: deps.isProcessAlive ?? defaultIsProcessAlive,
    socketExists: deps.socketExists ?? existsSync,
  });
  if (!validation.ok) {
    if (validation.code === 'protocol_mismatch') {
      return { ok: false, code: 'protocol_mismatch', message: validation.message };
    }
    if (validation.code === 'server_draining') {
      return { ok: false, code: 'server_draining', message: validation.message };
    }
    if (validation.code === 'invalid_manifest' || validation.code === 'manifest_version_mismatch') {
      return { ok: false, code: 'invalid_manifest', message: validation.message };
    }
    return unavailable();
  }
  try {
    await (deps.socketProbe ?? probeGatewaySocket)(validation.manifest.unixSocketPath);
  } catch {
    return unavailable();
  }
  return {
    ok: true,
    manifestVersion: validation.manifest.manifestVersion,
    socketPath: validation.manifest.unixSocketPath,
    webOrigin: validation.manifest.webOrigin,
    serverVersion: validation.manifest.serverVersion,
  };
}

function unavailable(): ClientEndpointError {
  return {
    ok: false,
    code: 'server_unavailable',
    message: 'MetaWork Server is unavailable; run `metawork server start`.',
  };
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function probeGatewaySocket(socketPath: string): Promise<void> {
  const socket = createConnection(socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Gateway health probe timed out'));
      }, 2_000);
      let buffer = '';
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('error', reject);
        socket.off('close', onClose);
        socket.off('data', onData);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Gateway health probe closed before hello'));
      };
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n');
          const raw = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!raw) continue;
          const message = JSON.parse(raw) as { type?: string };
          if (message.type === 'hello') {
            cleanup();
            resolve();
            socket.end();
            return;
          }
          if (message.type === 'event' || message.type === 'output') continue;
          cleanup();
          reject(new Error('Gateway health probe returned an invalid hello'));
          socket.destroy();
          return;
        }
      };
      socket.once('error', reject);
      socket.once('close', onClose);
      socket.on('data', onData);
    });
  } finally {
    socket.destroy();
  }
}
