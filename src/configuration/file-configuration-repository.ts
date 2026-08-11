import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { load } from 'js-yaml';
import {
  ActivationJournalStore,
  type ActivationJournalIdentity,
} from './activation-journal.js';
import { parseAnyFusionConfigurationV2 } from './schema.js';
import type { ConfigurationSnapshot } from './types.js';

const REVISION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

interface RevisionManifest {
  schemaVersion: 1;
  revisionId: string;
  contentHash: string;
  files: Array<{ path: string; sha256: string }>;
}

export interface WriteConfigurationRevisionInput {
  revisionId: string;
  contentHash: string;
  files: Record<string, string | Buffer>;
}

export type ConfigurationRecoveryResult =
  | { status: 'empty'; activeRevisionId: null }
  | { status: 'healthy' | 'recovered'; activeRevisionId: string };

export class RevisionConflictError extends Error {
  constructor(readonly activeRevisionId: string | null) {
    super('configuration revision conflict');
  }
}

export class RecoveryBlockedError extends Error {
  readonly code = 'configuration_recovery_blocked';
}

export class FileConfigurationRepository {
  readonly rootPath: string;
  readonly revisionsPath: string;
  readonly activePath: string;
  readonly journal: ActivationJournalStore;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
    this.revisionsPath = join(this.rootPath, 'revisions');
    this.activePath = join(this.rootPath, 'active');
    this.journal = new ActivationJournalStore(join(this.rootPath, 'activation-journal.json'));
  }

  async initialize(): Promise<void> {
    await mkdir(this.revisionsPath, { recursive: true, mode: 0o700 });
  }

  async writeRevision(input: WriteConfigurationRevisionInput): Promise<void> {
    assertRevisionId(input.revisionId);
    const finalPath = this.revisionPath(input.revisionId);
    if (await pathExists(finalPath)) {
      throw new Error(`configuration revision already exists: ${input.revisionId}`);
    }

    const stagePath = join(this.revisionsPath, `.stage-${input.revisionId}-${randomUUID()}`);
    await mkdir(stagePath, { recursive: false, mode: 0o700 });
    try {
      const manifestFiles: RevisionManifest['files'] = [];
      for (const [relativePath, value] of Object.entries(input.files).sort(([a], [b]) => a.localeCompare(b))) {
        const destination = resolveInside(stagePath, relativePath);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
        await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        await syncFile(destination);
        manifestFiles.push({
          path: relativePath,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }

      const manifest: RevisionManifest = {
        schemaVersion: 1,
        revisionId: input.revisionId,
        contentHash: input.contentHash,
        files: manifestFiles,
      };
      const manifestPath = join(stagePath, 'revision-manifest.json');
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await syncFile(manifestPath);
      await syncDirectory(stagePath);
      await rename(stagePath, finalPath);
      await syncDirectory(this.revisionsPath);
      await makeTreeImmutable(finalPath);
    } catch (error) {
      await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async readSnapshot(revisionId: string): Promise<ConfigurationSnapshot> {
    const manifest = await this.verifyRevision(revisionId);
    const configSource = await readFile(join(this.revisionPath(revisionId), 'config.yaml'), 'utf8');
    return {
      revisionId,
      contentHash: manifest.contentHash,
      config: parseAnyFusionConfigurationV2(load(configSource)),
    };
  }

  async getActiveSnapshot(): Promise<ConfigurationSnapshot> {
    const activeRevisionId = await this.readActiveRevisionId();
    if (!activeRevisionId) {
      throw new RecoveryBlockedError('active configuration revision is missing');
    }
    try {
      return await this.readSnapshot(activeRevisionId);
    } catch (error) {
      throw new RecoveryBlockedError(
        `active configuration revision failed integrity validation: ${errorMessage(error)}`,
      );
    }
  }

  async activateRevision(
    revisionId: string,
    expectedActiveRevisionId: string | null,
    transactionId = `activation-${randomUUID()}`,
  ): Promise<void> {
    await this.verifyRevision(revisionId);
    const activeRevisionId = await this.readActiveRevisionId();
    if (activeRevisionId !== expectedActiveRevisionId) {
      throw new RevisionConflictError(activeRevisionId);
    }

    const identity: ActivationJournalIdentity = {
      transactionId,
      previousRevisionId: activeRevisionId,
      nextRevisionId: revisionId,
    };
    await this.journal.writePrepared(identity);
    await this.replaceActivePointer(revisionId);
    await this.journal.writeCommitted(identity);
  }

  async replaceActivePointer(revisionId: string): Promise<void> {
    assertRevisionId(revisionId);
    const temporaryPath = join(this.rootPath, `.active-${randomUUID()}`);
    await symlink(join('revisions', revisionId), temporaryPath, 'dir');
    await rename(temporaryPath, this.activePath);
    await syncDirectory(this.rootPath);
  }

  async recover(): Promise<ConfigurationRecoveryResult> {
    const journal = await this.journal.read();
    const activeRevisionId = await this.readActiveRevisionId();

    if (!journal) {
      if (!activeRevisionId) return { status: 'empty', activeRevisionId: null };
      await this.assertActiveHealthy(activeRevisionId);
      return { status: 'healthy', activeRevisionId };
    }

    if (journal.phase === 'prepared') {
      if (activeRevisionId === journal.previousRevisionId) {
        if (activeRevisionId) await this.assertActiveHealthy(activeRevisionId);
        await this.journal.clear();
        return activeRevisionId
          ? { status: 'recovered', activeRevisionId }
          : { status: 'empty', activeRevisionId: null };
      }
      if (activeRevisionId === journal.nextRevisionId) {
        await this.assertActiveHealthy(activeRevisionId);
        await this.journal.writeCommitted(journal);
        return { status: 'recovered', activeRevisionId };
      }
      throw new RecoveryBlockedError('prepared activation journal does not match active pointer');
    }

    if (activeRevisionId !== journal.nextRevisionId) {
      throw new RecoveryBlockedError('committed activation journal does not match active pointer');
    }
    await this.assertActiveHealthy(activeRevisionId);
    return { status: 'healthy', activeRevisionId };
  }

  private async verifyRevision(revisionId: string): Promise<RevisionManifest> {
    assertRevisionId(revisionId);
    const revisionPath = this.revisionPath(revisionId);
    const source = await readFile(join(revisionPath, 'revision-manifest.json'), 'utf8');
    const manifest = JSON.parse(source) as RevisionManifest;
    if (
      manifest.schemaVersion !== 1
      || manifest.revisionId !== revisionId
      || typeof manifest.contentHash !== 'string'
      || !Array.isArray(manifest.files)
    ) {
      throw new Error(`invalid configuration revision manifest: ${revisionId}`);
    }
    for (const entry of manifest.files) {
      const bytes = await readFile(resolveInside(revisionPath, entry.path));
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== entry.sha256) {
        throw new Error(`configuration revision hash mismatch: ${entry.path}`);
      }
    }
    return manifest;
  }

  private async readActiveRevisionId(): Promise<string | null> {
    const target = await readlink(this.activePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new RecoveryBlockedError('active configuration pointer is not a symlink');
    });
    if (target === null) return null;
    const normalized = target.replaceAll('\\', '/');
    const prefix = 'revisions/';
    if (!normalized.startsWith(prefix)) {
      throw new RecoveryBlockedError('active configuration pointer escapes revision storage');
    }
    const revisionId = normalized.slice(prefix.length);
    assertRevisionId(revisionId);
    return revisionId;
  }

  private async assertActiveHealthy(revisionId: string): Promise<void> {
    try {
      await this.verifyRevision(revisionId);
    } catch (error) {
      throw new RecoveryBlockedError(
        `active configuration revision failed integrity validation: ${errorMessage(error)}`,
      );
    }
  }

  private revisionPath(revisionId: string): string {
    return join(this.revisionsPath, revisionId);
  }
}

async function makeTreeImmutable(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      await makeTreeImmutable(childPath);
    } else {
      await chmod(childPath, 0o444);
    }
  }
  await chmod(path, 0o555);
}

function resolveInside(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes('\0')) throw new Error('invalid revision file path');
  const resolved = resolve(root, relativePath);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel === '') {
    throw new Error(`revision file path escapes revision directory: ${relativePath}`);
  }
  return resolved;
}

function assertRevisionId(revisionId: string): void {
  if (!REVISION_ID.test(revisionId)) {
    throw new Error(`invalid configuration revision ID: ${revisionId}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
