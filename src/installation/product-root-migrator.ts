import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { isInstanceRunning } from '../management/lock.js';
import {
  assertLauncherAvailable,
  installNativeLauncher,
} from './native-launcher.js';
import { resolveMetaWorkPaths, type MetaWorkPaths } from './paths.js';

const JOURNAL_SCHEMA_VERSION = 1;

interface ProductRootManifest {
  readonly schemaVersion: 1;
  readonly entries: ProductRootManifestEntry[];
}

interface ProductRootManifestEntry {
  readonly path: string;
  readonly kind: 'directory' | 'file' | 'symlink';
  readonly size?: number;
  readonly sha256?: string;
  readonly target?: string;
}

interface ProductRootMigrationJournal {
  readonly schemaVersion: 1;
  readonly phase: 'prepared' | 'activated';
  readonly legacyRoot: string;
  readonly canonicalRoot: string;
  readonly stageRoot: string;
  readonly manifest: ProductRootManifest;
  readonly manifestHash: string;
}

export interface ProductRootMigration {
  readonly outcome: 'not_needed' | 'prepared';
  readonly paths: MetaWorkPaths;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export class ProductRootMigrator {
  private readonly userHome: string;
  private readonly now: () => string;

  constructor(private readonly options: {
    userHome?: string;
    now?: () => string;
    verifyCandidate?: (root: string) => Promise<void>;
  } = {}) {
    this.userHome = options.userHome ?? homedir();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async prepare(): Promise<ProductRootMigration> {
    const paths = resolveMetaWorkPaths(this.userHome);
    const legacyRoot = join(this.userHome, '.anyfusion');
    const journalPath = join(this.userHome, '.metawork-root-migration.json');
    const existingJournal = await readJournal(journalPath);
    if (existingJournal) {
      assertJournalIdentity(existingJournal, legacyRoot, paths.root);
      return this.resume(existingJournal, journalPath, paths);
    }

    const [legacyPresent, canonicalPresent] = await Promise.all([
      directoryHasContent(legacyRoot),
      directoryHasContent(paths.root),
    ]);
    if (!legacyPresent) return notNeededMigration(paths);
    if (canonicalPresent) {
      throw new Error(
        'both legacy AnyFusion and MetaWork roots contain state without a migration journal',
      );
    }
    await rm(paths.root, { recursive: true, force: true });
    await Promise.all(launcherPaths(paths).map(path => assertLauncherAvailable(path)));

    if (await isInstanceRunning(join(legacyRoot, 'data', 'runtime.lock'))) {
      throw new Error('legacy AnyFusion Server is still running; stop it before migration');
    }

    const stageRoot = `${paths.root}.staging-${randomUUID()}`;
    let activated = false;
    try {
      await cp(legacyRoot, stageRoot, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        filter: shouldCopyEntry,
      });
      const manifest = await collectManifest(stageRoot);
      await verifyManifest(stageRoot, manifest);
      await this.options.verifyCandidate?.(stageRoot);
      const journal: ProductRootMigrationJournal = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        phase: 'prepared',
        legacyRoot,
        canonicalRoot: paths.root,
        stageRoot,
        manifest,
        manifestHash: hashManifest(manifest),
      };
      await writeAtomicJson(journalPath, journal);
      await rename(stageRoot, paths.root);
      activated = true;
      await verifyManifest(paths.root, manifest);
      await writeAtomicJson(journalPath, { ...journal, phase: 'activated' });
      return this.migrationHandle(journal, journalPath, paths);
    } catch (error) {
      await rm(activated ? paths.root : stageRoot, { recursive: true, force: true });
      await rm(journalPath, { force: true });
      throw error;
    }
  }

  private async resume(
    journal: ProductRootMigrationJournal,
    journalPath: string,
    paths: MetaWorkPaths,
  ): Promise<ProductRootMigration> {
    if (journal.phase === 'prepared') {
      if (await pathExists(journal.canonicalRoot)) {
        await verifyManifest(journal.canonicalRoot, journal.manifest);
      } else {
        await verifyManifest(journal.stageRoot, journal.manifest);
        await rename(journal.stageRoot, journal.canonicalRoot);
      }
      await writeAtomicJson(journalPath, { ...journal, phase: 'activated' });
    } else {
      await verifyManifest(journal.canonicalRoot, journal.manifest);
    }
    if (hashManifest(journal.manifest) !== journal.manifestHash) {
      throw new Error('MetaWork root migration manifest hash mismatch');
    }
    await this.options.verifyCandidate?.(journal.canonicalRoot);
    return this.migrationHandle(journal, journalPath, paths);
  }

  private migrationHandle(
    journal: ProductRootMigrationJournal,
    journalPath: string,
    paths: MetaWorkPaths,
  ): ProductRootMigration {
    return {
      outcome: 'prepared',
      paths,
      commit: async () => {
        const archiveRoot = `${journal.legacyRoot}.migrated-${sanitizeTimestamp(this.now())}`;
        if (await pathExists(archiveRoot)) {
          throw new Error(`legacy AnyFusion migration archive already exists: ${archiveRoot}`);
        }
        const launcherSnapshots = await Promise.all(
          launcherPaths(paths).map(path => readLauncherSnapshot(path)),
        );
        await rename(journal.legacyRoot, archiveRoot);
        try {
          for (const launcherPath of launcherPaths(paths)) {
            await installNativeLauncher(launcherPath, journal.canonicalRoot);
          }
          await rm(journal.stageRoot, { recursive: true, force: true });
          await rm(journalPath, { force: true });
        } catch (error) {
          await Promise.all(launcherSnapshots.map(restoreLauncherSnapshot));
          await rename(archiveRoot, journal.legacyRoot);
          throw error;
        }
      },
      rollback: async () => {
        await rm(journal.canonicalRoot, { recursive: true, force: true });
        await rm(journal.stageRoot, { recursive: true, force: true });
        await rm(journalPath, { force: true });
      },
    };
  }
}

function notNeededMigration(paths: MetaWorkPaths): ProductRootMigration {
  return {
    outcome: 'not_needed',
    paths,
    commit: async () => undefined,
    rollback: async () => undefined,
  };
}

interface LauncherSnapshot {
  readonly path: string;
  readonly content: string | null;
  readonly mode?: number;
}

function launcherPaths(paths: MetaWorkPaths): string[] {
  return [paths.launcher, paths.anyFusionLauncher, paths.metaclawLauncher];
}

async function readLauncherSnapshot(path: string): Promise<LauncherSnapshot> {
  try {
    const [content, entry] = await Promise.all([
      readFile(path, 'utf8'),
      lstat(path),
    ]);
    return { path, content, mode: entry.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, content: null };
    }
    throw error;
  }
}

async function restoreLauncherSnapshot(snapshot: LauncherSnapshot): Promise<void> {
  if (snapshot.content === null) {
    await rm(snapshot.path, { force: true });
    return;
  }
  await mkdir(dirname(snapshot.path), { recursive: true, mode: 0o700 });
  await writeFile(snapshot.path, snapshot.content, {
    encoding: 'utf8',
    mode: snapshot.mode ?? 0o755,
  });
  await chmod(snapshot.path, snapshot.mode ?? 0o755);
}

async function shouldCopyEntry(source: string): Promise<boolean> {
  const name = basename(source);
  if (name === 'runtime.lock' || name.endsWith('.sock')) return false;
  const entry = await lstat(source);
  return !entry.isSocket();
}

async function collectManifest(root: string): Promise<ProductRootManifest> {
  const entries: ProductRootManifestEntry[] = [];
  await collectManifestEntries(root, root, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { schemaVersion: 1, entries };
}

async function collectManifestEntries(
  root: string,
  current: string,
  entries: ProductRootManifestEntry[],
): Promise<void> {
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name);
    const entry = await lstat(path);
    const manifestPath = relative(root, path);
    if (entry.isDirectory()) {
      entries.push({ path: manifestPath, kind: 'directory' });
      await collectManifestEntries(root, path, entries);
    } else if (entry.isSymbolicLink()) {
      entries.push({
        path: manifestPath,
        kind: 'symlink',
        target: await readlink(path),
      });
    } else if (entry.isFile()) {
      entries.push({
        path: manifestPath,
        kind: 'file',
        size: entry.size,
        sha256: await hashFile(path),
      });
    }
  }
}

async function verifyManifest(
  root: string,
  expected: ProductRootManifest,
): Promise<void> {
  const actual = await collectManifest(root);
  if (hashManifest(actual) !== hashManifest(expected)) {
    throw new Error(`MetaWork root migration manifest mismatch: ${root}`);
  }
}

function hashManifest(manifest: ProductRootManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function readJournal(path: string): Promise<ProductRootMigrationJournal | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const journal = JSON.parse(raw) as ProductRootMigrationJournal;
  if (
    journal.schemaVersion !== JOURNAL_SCHEMA_VERSION
    || (journal.phase !== 'prepared' && journal.phase !== 'activated')
    || !journal.legacyRoot
    || !journal.canonicalRoot
    || !journal.stageRoot
    || !journal.manifest
    || !journal.manifestHash
  ) {
    throw new Error('invalid MetaWork root migration journal');
  }
  return journal;
}

function assertJournalIdentity(
  journal: ProductRootMigrationJournal,
  legacyRoot: string,
  canonicalRoot: string,
): void {
  if (
    journal.legacyRoot !== legacyRoot
    || journal.canonicalRoot !== canonicalRoot
  ) {
    throw new Error('MetaWork root migration journal identity mismatch');
  }
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.next-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const handle = await open(temporary, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function directoryHasContent(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

function sanitizeTimestamp(value: string): string {
  return value.replaceAll(':', '-').replaceAll('.', '-');
}
