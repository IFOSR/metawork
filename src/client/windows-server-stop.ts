import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createJsonLineParser, encodeJsonLine } from '../gateway/jsonl.js';
import { connectWindowsPipe, loadWindowsPipes } from '../platform/windows-pipe.js';
import { loadWindowsPrivateFiles } from '../platform/windows-private-files.js';
import { validateEndpointManifest } from '../server/server-endpoint-manifest.js';
import { readReleaseIdentity } from '../installation/release-identity.js';

/** Formal CLI lifecycle only. No HTTP route, renderer bridge or force-kill fallback. */
export async function requestWindowsServerStop(input: {
  root: string; modulePath: string; releaseRoot: string; expectedPid: number;
}): Promise<void> {
  const files = loadWindowsPrivateFiles(input.modulePath);
  const identity = await readReleaseIdentity(join(input.releaseRoot, 'release-identity.json'));
  const validated = validateEndpointManifest(JSON.parse(files.readPrivateFile(input.root, 'server-endpoint.json').toString()), {
    protocolVersion: 2, ...(identity ? { releaseId: identity.releaseId } : {}),
  });
  if (!validated.ok) throw new Error(validated.message);
  const manifest = validated.manifest;
  if (manifest.pid !== input.expectedPid) throw new Error('Server stop PID does not match the runtime lock');
  const nonce = randomBytes(32).toString('hex');
  const socket = await connectWindowsPipe(loadWindowsPipes(input.modulePath), manifest.unixSocketPath, manifest.pid);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Server stop request timed out')), 2000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      socket.on('data', createJsonLineParser<Record<string, unknown>>(message => {
        if (message.type === 'server_stop_accepted' && message.nonce === nonce) finish();
        else if (message.type === 'error') finish(new Error('Server stop request rejected'));
      }, { maxFrameBytes: 4096, onError: finish }));
      socket.once('error', () => finish(new Error('Server stop transport failed')));
      socket.once('close', () => finish(new Error('Server closed before stop acknowledgement')));
      socket.write(encodeJsonLine({ type: 'request_server_stop', nonce, pid: manifest.pid, startedAt: manifest.startedAt }));
    });
  } finally { socket.destroy(); }
  // An acknowledgement or disappearing PID is not evidence of a successful
  // drain. The Server writes this nonce-bound receipt only after stop() settles.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const receipt = JSON.parse(files.readPrivateFile(input.root, 'server-stop-receipt.json').toString()) as Record<string, unknown>;
      if (receipt.nonce === nonce && receipt.pid === manifest.pid && receipt.startedAt === manifest.startedAt) {
        if (receipt.stopped !== true) throw new Error('Server drain did not complete cleanly');
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Server stop completion receipt is unavailable');
}
