import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const BUILD_SOURCE_METADATA_VERSION = 1 as const;

export interface BuildSourceMetadata {
  readonly version: typeof BUILD_SOURCE_METADATA_VERSION;
  readonly sourceRoot: string;
  readonly plannerRoot: string;
}

export function buildSourceMetadataPath(installationRoot: string): string {
  return join(installationRoot, 'build-source.json');
}

export async function readBuildSourceMetadata(
  path: string,
): Promise<BuildSourceMetadata | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  assertBuildSourceMetadata(value);
  return value;
}

export async function writeBuildSourceMetadata(
  path: string,
  metadata: Omit<BuildSourceMetadata, 'version'>,
): Promise<void> {
  const value: BuildSourceMetadata = {
    version: BUILD_SOURCE_METADATA_VERSION,
    sourceRoot: metadata.sourceRoot,
    plannerRoot: metadata.plannerRoot,
  };
  assertBuildSourceMetadata(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function assertBuildSourceMetadata(value: unknown): asserts value is BuildSourceMetadata {
  const candidate = value as Record<string, unknown>;
  if (
    typeof value !== 'object'
    || value === null
    || candidate.version !== BUILD_SOURCE_METADATA_VERSION
    || typeof candidate.sourceRoot !== 'string'
    || candidate.sourceRoot.length === 0
    || typeof candidate.plannerRoot !== 'string'
    || candidate.plannerRoot.length === 0
  ) {
    throw new Error('MetaWork build source metadata is invalid');
  }
}
