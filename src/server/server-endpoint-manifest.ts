import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const ENDPOINT_MANIFEST_VERSION = 1 as const;

export interface EndpointManifest {
  readonly manifestVersion: typeof ENDPOINT_MANIFEST_VERSION;
  readonly releaseId?: string;
  readonly serverVersion: string;
  readonly gatewayProtocolVersion: number;
  readonly pid: number;
  readonly startedAt: string;
  readonly state: 'ready' | 'draining';
  readonly unixSocketPath: string;
  readonly webOrigin: string;
}

export type EndpointValidationCode =
  | 'manifest_version_mismatch'
  | 'invalid_manifest'
  | 'server_draining'
  | 'protocol_mismatch'
  | 'release_mismatch'
  | 'server_not_running'
  | 'socket_unavailable';

export type EndpointValidationResult =
  | { readonly ok: true; readonly manifest: EndpointManifest }
  | { readonly ok: false; readonly code: EndpointValidationCode; readonly message: string };

export interface EndpointValidationDeps {
  readonly protocolVersion?: number;
  readonly releaseId?: string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly socketExists?: (path: string) => boolean;
}

export type ServerReadiness = 'ready' | 'starting_or_failed' | 'not_running';

export async function writeEndpointManifest(
  path: string,
  manifest: EndpointManifest,
): Promise<void> {
  assertManifest(manifest);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
}

export async function readEndpointManifest(path: string): Promise<EndpointManifest | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  assertManifest(parsed);
  return parsed;
}

export async function removeEndpointManifest(path: string): Promise<void> {
  await unlink(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

export function classifyServerReadiness(
  manifest: unknown,
  instanceRunning: boolean,
  deps: Pick<EndpointValidationDeps, 'isProcessAlive' | 'socketExists'> = {},
): ServerReadiness {
  if (!instanceRunning) return 'not_running';
  if (!manifest) return 'starting_or_failed';
  return validateEndpointManifest(manifest, deps).ok
    ? 'ready'
    : 'starting_or_failed';
}

export function validateEndpointManifest(
  manifest: unknown,
  deps: EndpointValidationDeps = {},
): EndpointValidationResult {
  if (!isRecord(manifest) || manifest.manifestVersion !== ENDPOINT_MANIFEST_VERSION) {
    return {
      ok: false,
      code: 'manifest_version_mismatch',
      message: 'Server endpoint manifest version is unsupported',
    };
  }
  try {
    assertManifest(manifest);
  } catch {
    return {
      ok: false,
      code: 'invalid_manifest',
      message: 'Server endpoint manifest is invalid',
    };
  }
  if (manifest.state !== 'ready') {
    return {
      ok: false,
      code: 'server_draining',
      message: 'MetaWork Server is draining',
    };
  }
  if (
    deps.protocolVersion !== undefined
    && deps.protocolVersion !== manifest.gatewayProtocolVersion
  ) {
    return {
      ok: false,
      code: 'protocol_mismatch',
      message: `Gateway protocol mismatch: client=${deps.protocolVersion}, server=${manifest.gatewayProtocolVersion}`,
    };
  }
  if (
    deps.releaseId !== undefined
    && deps.releaseId !== manifest.releaseId
  ) {
    return {
      ok: false,
      code: 'release_mismatch',
      message: `MetaWork release mismatch: client=${deps.releaseId}, server=${manifest.releaseId}; run \`metawork build\``,
    };
  }
  if (deps.isProcessAlive && !deps.isProcessAlive(manifest.pid)) {
    return {
      ok: false,
      code: 'server_not_running',
      message: `MetaWork Server PID ${manifest.pid} is not running`,
    };
  }
  if (deps.socketExists && !deps.socketExists(manifest.unixSocketPath)) {
    return {
      ok: false,
      code: 'socket_unavailable',
      message: 'MetaWork Server Unix Gateway socket is unavailable',
    };
  }
  return { ok: true, manifest };
}

function assertManifest(value: unknown): asserts value is EndpointManifest {
  const candidate = value as Record<string, unknown>;
  if (
    !isRecord(value)
    || candidate.manifestVersion !== ENDPOINT_MANIFEST_VERSION
    || typeof candidate.serverVersion !== 'string'
    || ('releaseId' in candidate && typeof candidate.releaseId !== 'string')
    || typeof candidate.gatewayProtocolVersion !== 'number'
    || !Number.isSafeInteger(candidate.pid)
    || (candidate.pid as number) <= 0
    || typeof candidate.startedAt !== 'string'
    || (candidate.state !== 'ready' && candidate.state !== 'draining')
    || typeof candidate.unixSocketPath !== 'string'
    || candidate.unixSocketPath.length === 0
    || typeof candidate.webOrigin !== 'string'
    || candidate.webOrigin.length === 0
    || 'workspace' in candidate
  ) {
    throw new Error('Invalid endpoint manifest');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
