import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RELEASE_IDENTITY_VERSION = 1 as const;

export interface ReleaseIdentity {
  readonly version: typeof RELEASE_IDENTITY_VERSION;
  readonly releaseId: string;
  readonly gatewayProtocolVersion: 2;
}

export function releaseIdentityPath(releaseRoot: string): string {
  return join(releaseRoot, 'release-identity.json');
}

export async function writeReleaseIdentity(
  releaseRoot: string,
  releaseId: string,
): Promise<void> {
  const identity: ReleaseIdentity = {
    version: RELEASE_IDENTITY_VERSION,
    releaseId,
    gatewayProtocolVersion: 2,
  };
  await writeFile(
    releaseIdentityPath(releaseRoot),
    `${JSON.stringify(identity, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

export async function readReleaseIdentity(path: string): Promise<ReleaseIdentity | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  const candidate = value as Record<string, unknown>;
  if (
    typeof value !== 'object'
    || value === null
    || candidate.version !== RELEASE_IDENTITY_VERSION
    || typeof candidate.releaseId !== 'string'
    || candidate.releaseId.length === 0
    || candidate.gatewayProtocolVersion !== 2
  ) {
    throw new Error(`release identity is invalid: ${path}`);
  }
  return value as ReleaseIdentity;
}
