/**
 * 账户布局迁移器（ADR-0031 第 9 节）。
 *
 * Legacy 状态先复制到 staging tree，生成并校验 tree manifest，再用一次目录
 * rename 激活。激活 journal 允许在 rename 与 account.json 写入之间崩溃后
 * 确定性恢复；没有 journal 的混合布局一律 fail closed。
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cp,
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
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { FileAccountRepository } from '../account/file-account-repository.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import { resolveAccountPaths } from '../account/account-paths.js';
import type { AnyFusionPaths } from './paths.js';

const LAYOUT_MANIFEST_NAME = 'account-layout-manifest.json';
const JOURNAL_SCHEMA_VERSION = 1;

export interface AccountLayoutMigrationResult {
  readonly outcome: 'migrated' | 'already_migrated';
  readonly accountId: string;
}

interface LayoutManifest {
  readonly schemaVersion: 1;
  readonly entries: LayoutManifestEntry[];
}

interface LayoutManifestEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly size?: number;
  readonly sha256?: string;
  readonly target?: string;
}

interface MigrationJournal {
  readonly schemaVersion: 1;
  readonly phase: 'prepared';
  readonly accountId: string;
  readonly stageRoot: string;
  readonly accountRoot: string;
  readonly manifest: LayoutManifest;
  readonly manifestHash: string;
}

export class AccountLayoutMigrator {
  private readonly accountId: string;
  private readonly now: () => string;

  constructor(private readonly deps: {
    paths: AnyFusionPaths;
    accountId?: string;
    now?: () => string;
    afterActivate?: () => Promise<void>;
  }) {
    this.accountId = deps.accountId ?? LOCAL_DEFAULT_ACCOUNT_ID;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async migrate(): Promise<AccountLayoutMigrationResult> {
    const paths = this.deps.paths;
    const accountPaths = resolveAccountPaths(this.accountId, paths.root);
    const repository = new FileAccountRepository(paths.accountsRoot);
    const migrationRoot = join(paths.accountsRoot, '.migrations');
    const journalPath = join(migrationRoot, `${this.accountId}.json`);
    const stageRoot = join(migrationRoot, `${this.accountId}.staging`);

    const existing = await repository.load(this.accountId);
    if (existing?.migratedAt) {
      // The manifest seals the migration staging tree. Account data is mutable
      // after activation, so ordinary startup must not compare the live tree
      // against that historical migration snapshot.
      await this.ensureManifest(accountPaths.root);
      if (await this.hasLegacyState(paths)) {
        await this.archiveLegacyState(paths);
      }
      return { outcome: 'already_migrated', accountId: this.accountId };
    }

    const journal = await this.readJournal(journalPath);
    if (journal) {
      await this.assertJournalIdentity(journal, accountPaths, stageRoot);
      await this.resumePreparedMigration(journal, journalPath, repository, paths);
      return { outcome: 'migrated', accountId: this.accountId };
    }

    const legacyPresent = await this.hasLegacyState(paths);
    const accountPresent = await this.directoryHasContent(accountPaths.root);
    if (legacyPresent && accountPresent) {
      throw new Error(
        'mixed account layout detected: legacy state and an unjournaled account root both exist',
      );
    }

    if (accountPresent) {
      const manifest = await this.ensureManifest(accountPaths.root);
      await this.verifyManifest(accountPaths.root, manifest);
      await repository.save({
        accountId: this.accountId,
        schemaVersion: 1,
        migratedAt: this.now(),
      });
      return { outcome: 'migrated', accountId: this.accountId };
    }

    await this.assertLegacyDatabaseIntegrity(paths.database);
    await rm(stageRoot, { recursive: true, force: true });
    await mkdir(migrationRoot, { recursive: true, mode: 0o700 });
    await this.populateStage(paths, accountPaths, stageRoot);
    const manifest = await this.ensureManifest(stageRoot);
    await this.verifyManifest(stageRoot, manifest);
    const prepared: MigrationJournal = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      phase: 'prepared',
      accountId: this.accountId,
      stageRoot,
      accountRoot: accountPaths.root,
      manifest,
      manifestHash: hashManifest(manifest),
    };
    await writeAtomicJson(journalPath, prepared);

    let activated = false;
    try {
      await mkdir(dirname(accountPaths.root), { recursive: true, mode: 0o700 });
      await rename(stageRoot, accountPaths.root);
      activated = true;
      await this.deps.afterActivate?.();
      await this.verifyManifest(accountPaths.root, manifest);
      await this.archiveLegacyState(paths);
      await repository.save({
        accountId: this.accountId,
        schemaVersion: 1,
        migratedAt: this.now(),
      });
      await rm(journalPath, { force: true });
      return { outcome: 'migrated', accountId: this.accountId };
    } catch (error) {
      if (!activated) {
        await rm(stageRoot, { recursive: true, force: true });
        await rm(journalPath, { force: true });
      }
      throw error;
    }
  }

  private async resumePreparedMigration(
    journal: MigrationJournal,
    journalPath: string,
    repository: FileAccountRepository,
    paths: AnyFusionPaths,
  ): Promise<void> {
    const finalPresent = await this.pathExists(journal.accountRoot);
    if (!finalPresent) {
      if (!(await this.pathExists(journal.stageRoot))) {
        throw new Error('account migration journal exists but its staging tree is missing');
      }
      await this.verifyManifest(journal.stageRoot, journal.manifest);
      await mkdir(dirname(journal.accountRoot), { recursive: true, mode: 0o700 });
      await rename(journal.stageRoot, journal.accountRoot);
    }
    await this.verifyManifest(journal.accountRoot, journal.manifest);
    if (hashManifest(await this.readManifest(journal.accountRoot)) !== journal.manifestHash) {
      throw new Error('account migration manifest hash mismatch during recovery');
    }
    await this.archiveLegacyState(paths);
    await repository.save({
      accountId: this.accountId,
      schemaVersion: 1,
      migratedAt: this.now(),
    });
    await rm(journalPath, { force: true });
  }

  private async populateStage(
    paths: AnyFusionPaths,
    accountPaths: ReturnType<typeof resolveAccountPaths>,
    stageRoot: string,
  ): Promise<void> {
    for (const dir of [
      stageRoot,
      accountPaths.config.replace(accountPaths.root, stageRoot),
      accountPaths.data.replace(accountPaths.root, stageRoot),
      accountPaths.secrets.replace(accountPaths.root, stageRoot),
      accountPaths.generated.replace(accountPaths.root, stageRoot),
      accountPaths.generatedAgentRuntime.replace(accountPaths.root, stageRoot),
      accountPaths.plannerSessions.replace(accountPaths.root, stageRoot),
      accountPaths.conversations.replace(accountPaths.root, stageRoot),
      accountPaths.workspaceStore.replace(accountPaths.root, stageRoot),
      accountPaths.attempts.replace(accountPaths.root, stageRoot),
      accountPaths.gateway.replace(accountPaths.root, stageRoot),
      accountPaths.databaseRevisions.replace(accountPaths.root, stageRoot),
      accountPaths.backups.replace(accountPaths.root, stageRoot),
    ]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }

    const stagedDatabase = join(
      accountPaths.databaseRevisions.replace(accountPaths.root, stageRoot),
      'legacy-migration.db',
    );
    if (await this.pathExists(paths.database)) {
      await this.backupSqliteDatabase(paths.database, stagedDatabase);
      this.assertSqliteIntegrity(stagedDatabase);
      await symlink(join('database-revisions', basename(stagedDatabase)), accountPaths.database.replace(accountPaths.root, stageRoot));
    }

    await this.copyDirectoryIfExists(
      paths.plannerSessions,
      accountPaths.plannerSessions.replace(accountPaths.root, stageRoot),
    );
    await this.copyDirectoryIfExists(
      paths.executionWorkspaces,
      accountPaths.workspaceStore.replace(accountPaths.root, stageRoot),
    );
    await this.copyDirectoryIfExists(
      paths.attempts,
      accountPaths.attempts.replace(accountPaths.root, stageRoot),
    );
    const sourceConfigRoot = dirname(paths.configurationRevisions);
    const stagedConfigRoot = accountPaths.config.replace(accountPaths.root, stageRoot);
    await this.copyDirectoryIfExists(sourceConfigRoot, stagedConfigRoot);
    await this.rebuildConfigurationActivePointer(sourceConfigRoot, stagedConfigRoot);
    await this.copyDirectoryIfExists(paths.secrets, accountPaths.secrets.replace(accountPaths.root, stageRoot));
    await this.copyDirectoryIfExists(
      dirname(paths.generatedAgentRuntime),
      accountPaths.generated.replace(accountPaths.root, stageRoot),
    );
  }

  private async ensureManifest(root: string): Promise<LayoutManifest> {
    const manifestPath = join(root, LAYOUT_MANIFEST_NAME);
    if (await this.pathExists(manifestPath)) {
      return this.readManifest(root);
    }
    const manifest = await collectManifest(root);
    await writeAtomicJson(manifestPath, manifest);
    return manifest;
  }

  private async readManifest(root: string): Promise<LayoutManifest> {
    const value = JSON.parse(await readFile(join(root, LAYOUT_MANIFEST_NAME), 'utf8')) as LayoutManifest;
    if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
      throw new Error('invalid account layout manifest');
    }
    return value;
  }

  private async verifyManifest(root: string, expected: LayoutManifest): Promise<void> {
    const actual = await collectManifest(root);
    if (hashManifest(actual) !== hashManifest(expected)) {
      throw new Error(`account layout manifest mismatch: ${root}`);
    }
  }

  private async rebuildConfigurationActivePointer(
    sourceConfigRoot: string,
    targetConfigRoot: string,
  ): Promise<void> {
    const sourceActive = join(sourceConfigRoot, 'active');
    let target: string;
    try {
      target = await readlink(sourceActive);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT'
        || (error as NodeJS.ErrnoException).code === 'EINVAL') {
        return;
      }
      throw error;
    }
    const targetActive = join(targetConfigRoot, 'active');
    await rm(targetActive, { recursive: true, force: true });
    await symlink(join('revisions', basename(target)), targetActive, 'dir');
  }

  private async assertLegacyDatabaseIntegrity(databasePath: string): Promise<void> {
    if (await this.pathExists(databasePath)) this.assertSqliteIntegrity(databasePath);
  }

  private async backupSqliteDatabase(sourcePath: string, targetPath: string): Promise<void> {
    await rm(targetPath, { force: true });
    const source = new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await source.backup(targetPath);
    } finally {
      source.close();
    }
  }

  private assertSqliteIntegrity(path: string): void {
    const db = new Database(path, { readonly: true });
    try {
      const result = db.pragma('integrity_check', { simple: true });
      if (result !== 'ok') {
        throw new Error(`sqlite integrity check failed for ${basename(path)}: ${String(result)}`);
      }
    } finally {
      db.close();
    }
  }

  private async copyDirectoryIfExists(source: string, target: string): Promise<void> {
    if (!(await this.pathExists(source))) return;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(source, target, { recursive: true, preserveTimestamps: true });
  }

  private async hasLegacyState(paths: AnyFusionPaths): Promise<boolean> {
    return (await this.pathExists(paths.database))
      || (await this.directoryHasContent(paths.plannerSessions))
      || (await this.directoryHasContent(paths.executionWorkspaces))
      || (await this.directoryHasContent(paths.attempts))
      || (await this.directoryHasContent(dirname(paths.configurationRevisions)))
      || (await this.directoryHasContent(dirname(paths.generatedAgentRuntime)))
      || (await this.directoryHasContent(paths.secrets));
  }

  private async archiveLegacyState(paths: AnyFusionPaths): Promise<void> {
    const archiveRoot = join(
      paths.root,
      'legacy-account-layout',
      this.accountId,
    );
    const databaseArchive = join(archiveRoot, 'data', basename(paths.database));
    const entries: ReadonlyArray<readonly [string, string]> = [
      [paths.database, databaseArchive],
      [`${paths.database}-wal`, `${databaseArchive}-wal`],
      [`${paths.database}-shm`, `${databaseArchive}-shm`],
      [paths.plannerSessions, join(archiveRoot, 'data', 'planner-sessions')],
      [paths.executionWorkspaces, join(archiveRoot, 'data', 'execution-workspaces')],
      [paths.attempts, join(archiveRoot, 'tmp', 'attempts')],
      [dirname(paths.configurationRevisions), join(archiveRoot, 'config')],
      [dirname(paths.generatedAgentRuntime), join(archiveRoot, 'generated')],
    ];
    for (const [source, target] of entries) {
      await this.archiveLegacyEntry(source, target);
    }
  }

  private async archiveLegacyEntry(source: string, target: string): Promise<void> {
    const [sourcePresent, targetPresent] = await Promise.all([
      this.pathExists(source),
      this.pathExists(target),
    ]);
    if (sourcePresent && targetPresent) {
      throw new Error(`legacy archive conflict: both source and target exist for ${source}`);
    }
    if (!sourcePresent) return;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await rename(source, target);
  }

  private async directoryHasContent(path: string): Promise<boolean> {
    try {
      return (await readdir(path)).length > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async assertJournalIdentity(
    journal: MigrationJournal,
    accountPaths: ReturnType<typeof resolveAccountPaths>,
    stageRoot: string,
  ): Promise<void> {
    if (
      journal.schemaVersion !== JOURNAL_SCHEMA_VERSION
      || journal.phase !== 'prepared'
      || journal.accountId !== this.accountId
      || journal.accountRoot !== accountPaths.root
      || journal.stageRoot !== stageRoot
      || journal.manifestHash !== hashManifest(journal.manifest)
    ) {
      throw new Error('account migration journal identity or manifest is invalid');
    }
  }

  private async readJournal(path: string): Promise<MigrationJournal | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as MigrationJournal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}

async function collectManifest(root: string): Promise<LayoutManifest> {
  const entries: LayoutManifestEntry[] = [];
  await walk(root, '');
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { schemaVersion: 1, entries };

  async function walk(current: string, relativePath: string): Promise<void> {
    const names = (await readdir(current, { withFileTypes: true }))
      .filter(entry => (
        relativePath !== ''
        || (entry.name !== LAYOUT_MANIFEST_NAME && entry.name !== 'account.json')
      ))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of names) {
      const entryPath = join(current, entry.name);
      const entryRelativePath = relativePath ? join(relativePath, entry.name) : entry.name;
      if (entry.isSymbolicLink()) {
        entries.push({
          path: entryRelativePath,
          kind: 'symlink',
          target: await readlink(entryPath),
        });
      } else if (entry.isDirectory()) {
        entries.push({ path: entryRelativePath, kind: 'directory' });
        await walk(entryPath, entryRelativePath);
      } else if (entry.isFile()) {
        const info = await lstat(entryPath);
        entries.push({
          path: entryRelativePath,
          kind: 'file',
          size: info.size,
          sha256: await hashFile(entryPath),
        });
      } else {
        throw new Error(`unsupported account layout entry: ${entryRelativePath}`);
      }
    }
  }
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
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
  const directory = await open(parent, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function hashManifest(manifest: LayoutManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
