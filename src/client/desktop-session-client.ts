import { createHash, randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { isAbsolute, relative, sep } from 'node:path';
import { createJsonLineParser, encodeJsonLine } from '../gateway/jsonl.js';
import { isDesktopNonce, type DesktopSessionGrant } from '../gateway/desktop-session-contract.js';
import { readEndpointManifest } from '../server/server-endpoint-manifest.js';
import { resolveClientEndpoint } from './client-endpoint-resolver.js';

export function assertLoopbackOrigin(value: string): void {
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || url.username || url.password || !url.port) throw new Error('Invalid Desktop Server origin');
}

/** macOS/Unix only: Windows must supply a separately reviewed named-pipe ACL adapter. */
export async function discoverDesktopSession(input: {
  installRoot: string;
  manifestPath: string;
  releaseId: string;
}): Promise<DesktopSessionGrant> {
  if (typeof process.getuid !== 'function') throw new Error('Desktop local authentication requires Unix');
  const root = await realpath(input.installRoot);
  await assertOwnedPrivateFile(input.manifestPath, root, false);
  const manifest = await readEndpointManifest(input.manifestPath);
  if (!manifest) throw new Error('Server endpoint is unavailable');
  assertLoopbackOrigin(manifest.webOrigin);
  await assertOwnedPrivateFile(manifest.unixSocketPath, root, true);
  const endpoint = await resolveClientEndpoint(input.manifestPath, 2, { releaseId: input.releaseId });
  if (!endpoint.ok) throw new Error(endpoint.message);
  const nonce = randomBytes(32).toString('hex');
  const grant = await requestDesktopSession(endpoint.socketPath, nonce);
  if (grant.nonce !== nonce || grant.pid !== manifest.pid
    || grant.webOrigin !== manifest.webOrigin || grant.releaseId !== input.releaseId
    || grant.installationId !== createHash('sha256').update(root).digest('hex')) {
    throw new Error('Desktop Server identity mismatch');
  }
  return grant;
}

async function assertOwnedPrivateFile(path: string, root: string, socket: boolean): Promise<void> {
  if (!isAbsolute(path)) throw new Error('Local endpoint path must be absolute');
  const info = await lstat(path);
  const canonical = await realpath(path);
  const child = relative(root, canonical);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)
    || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0
    || (socket ? !info.isSocket() : !info.isFile())) {
    throw new Error('Local endpoint ownership or permissions are invalid');
  }
}

export function requestDesktopSession(socketPath: string, nonce: string): Promise<DesktopSessionGrant> {
  if (!isDesktopNonce(nonce)) return Promise.reject(new Error('Invalid Desktop nonce'));
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (error?: Error, grant?: DesktopSessionGrant) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(grant!);
    };
    const timer = setTimeout(() => finish(new Error('Desktop authentication timed out')), 2_000);
    const parse = createJsonLineParser<Record<string, unknown>>(message => {
      if (message.type === 'error') finish(new Error('Desktop authentication is unavailable'));
      if (message.type !== 'desktop_session_registered') return;
      const grant = message.grant as DesktopSessionGrant | undefined;
      if (!grant || !isDesktopNonce(grant.ticket) || !isDesktopNonce(grant.proof)
        || grant.nonce !== nonce || !isDesktopNonce(grant.installationId)
        || typeof grant.instanceId !== 'string' || !/^[\w-]{1,128}$/u.test(grant.instanceId)
        || typeof grant.accountId !== 'string' || !/^[\w-]{1,128}$/u.test(grant.accountId)
        || typeof grant.releaseId !== 'string' || grant.releaseId.length > 128
        || typeof grant.webOrigin !== 'string' || grant.webOrigin.length > 128
        || !Number.isSafeInteger(grant.pid) || grant.pid <= 0
        || grant.gatewayProtocolVersion !== 2 || !Number.isFinite(grant.expiresAt)
        || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + 16_000) {
        finish(new Error('Invalid Desktop session response'));
        return;
      }
      try { assertLoopbackOrigin(grant.webOrigin); }
      catch { finish(new Error('Invalid Desktop session origin')); return; }
      finish(undefined, grant);
    }, { maxFrameBytes: 4096, onError: error => finish(error) });
    socket.once('connect', () => socket.write(encodeJsonLine({ type: 'register_desktop_session', nonce })));
    socket.on('data', parse);
    socket.once('error', () => finish(new Error('Desktop Gateway is unavailable')));
    socket.once('close', () => finish(new Error('Desktop Gateway closed before authentication')));
  });
}

/** fetch must be bound to the Electron session whose HttpOnly cookie will be used by Web. */
export async function exchangeDesktopSession(
  grant: DesktopSessionGrant,
  sessionFetch: typeof fetch,
  reuseSession = false,
): Promise<void> {
  const proofResponse = await sessionFetch(`${grant.webOrigin}/api/auth/desktop-instance?nonce=${grant.nonce}`, {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
  });
  if (!proofResponse.ok || (await proofResponse.json() as { proof?: unknown }).proof !== grant.proof) {
    throw new Error('HTTP Server does not match the local Gateway');
  }
  if (reuseSession) {
    const current = await sessionFetch(`${grant.webOrigin}/api/auth/session`, {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    if (current.ok && (await current.json() as { authenticated?: unknown }).authenticated === true) return;
  }
  const response = await sessionFetch(`${grant.webOrigin}/api/auth/desktop-session`, {
    method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', Origin: grant.webOrigin },
    body: JSON.stringify({ ticket: grant.ticket, nonce: grant.nonce, instanceId: grant.instanceId }),
  });
  if (!response.ok) throw new Error('Desktop session could not be established');
  const body = await response.json() as { authenticated?: unknown; instanceId?: unknown; accountId?: unknown };
  if (body.authenticated !== true || body.instanceId !== grant.instanceId || body.accountId !== grant.accountId) {
    throw new Error('Desktop session identity mismatch');
  }
}
