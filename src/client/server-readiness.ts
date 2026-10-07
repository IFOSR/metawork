import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { readEndpointManifest, validateEndpointManifest, type EndpointManifest } from '../server/server-endpoint-manifest.js';

/** A socket can exist before recovery/readiness publication has completed. */
export async function waitForStartedServer(
  child: ChildProcess,
  manifestPath: string,
  options: { releaseId?: string; timeoutMs?: number } = {},
): Promise<EndpointManifest> {
  let spawnError: Error | undefined;
  const onError = (error: Error): void => { spawnError = error; };
  child.on('error', onError);
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 90_000);
    do {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('MetaWork Server exited before becoming ready');
      }
      const manifest = await readEndpointManifest(manifestPath);
      if (manifest && manifest.pid === child.pid && validateEndpointManifest(manifest, {
        protocolVersion: 2,
        ...(options.releaseId ? { releaseId: options.releaseId } : {}),
        socketExists: existsSync,
      }).ok) return manifest;
      await setTimeout(100);
    } while (Date.now() < deadline);
    throw new Error('MetaWork Server did not publish a ready endpoint before the deadline');
  } finally {
    child.off('error', onError);
  }
}
