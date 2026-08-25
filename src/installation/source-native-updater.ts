import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import { resolveAccountPaths, type AccountPaths } from '../account/account-paths.js';
import { ConfigurationCompiler } from '../configuration/configuration-compiler.js';
import { ConfigurationService } from '../configuration/configuration-service.js';
import { createProductionConfigurationProbe } from '../configuration/production-configuration-probe.js';
import { FileConfigurationRepository } from '../configuration/file-configuration-repository.js';
import type { SecretStore } from '../configuration/secret-store.js';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../storage/migrations.js';
import { DatabaseUpgradeTransaction } from './database-upgrade-transaction.js';
import type { AnyFusionPaths } from './paths.js';
import { resolveReleasePaths } from './paths.js';
import {
  ReleasePointerTransaction,
  recoverPreparedReleaseActivations,
  readReleaseActivationJournal,
  type ReleasePointerName,
} from './release-pointer-transaction.js';
import { createMigrationContextFromSnapshot } from './schema30-migration-context.js';
import { stageSourceRelease } from './source-native-installer.js';
import { AccountLayoutMigrator } from './account-layout-migrator.js';
import { acquireRuntimeUpdateLock } from './runtime-update-lock.js';

export interface SourceNativeUpdateInput {
  releaseId: string;
  sourceRoot: string;
  plannerRoot: string;
}

export interface SourceNativeUpdateResult {
  outcome: 'committed';
  upgradeId: string;
  journalPath: string;
}

export class SourceNativeUpdater {
  constructor(private readonly dependencies: {
    paths: AnyFusionPaths;
    secretStore: SecretStore;
    detectCommand(command: string): Promise<boolean>;
    isServerRunning(): Promise<boolean>;
    afterSwitch?: (name: ReleasePointerName) => Promise<void>;
  }) {}

  async update(input: SourceNativeUpdateInput): Promise<SourceNativeUpdateResult> {
    const paths = this.dependencies.paths;
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root);
    if (await this.dependencies.isServerRunning()) {
      throw new Error(
        'running Server must be quiesced through ServerUpdateCoordinator before update',
      );
    }
    const lock = await acquireRuntimeUpdateLock(paths.root, 'update');
    try {
      await new AccountLayoutMigrator({ paths }).migrate();
      await ensureRevisionedDatabasePointer(accountPaths);
      const pointerPaths = releasePointerPaths(paths, accountPaths);
      await recoverPreparedReleaseActivations(paths.upgradeJournals, pointerPaths);
      const upgradeId = `update-${input.releaseId}-${randomUUID()}`;
      const release = resolveReleasePaths(paths.root, input.releaseId);
      const repository = new FileConfigurationRepository(accountPaths.config);
      await repository.initialize();
      await repository.recover();
      const snapshot = await repository.getActiveSnapshot();

      await stageSourceRelease(input.sourceRoot, input.plannerRoot, release.releaseRoot);
      const sourceSchema = readSchemaVersion(accountPaths.database);
      if (
        sourceSchema !== 30
        && sourceSchema !== 31
        && sourceSchema !== 32
        && sourceSchema !== 33
        && sourceSchema !== CURRENT_SCHEMA_VERSION
      ) {
        throw new Error(`unsupported update source schema: ${sourceSchema}`);
      }
      const candidateDatabase = join(accountPaths.databaseRevisions, `${upgradeId}.db`);
      const backupDatabase = join(accountPaths.backups, upgradeId, 'anyfusion.db');
      const migrationContext = sourceSchema === 30
        ? createMigrationContextFromSnapshot(snapshot)
        : undefined;
      const databaseTransaction = new DatabaseUpgradeTransaction({
        migrateClone: path => {
          const db = new Database(path);
          try {
            db.pragma('foreign_keys = ON');
            runMigrations(db, migrationContext);
          } finally {
            db.close();
          }
        },
      });
      await databaseTransaction.prepare({
        sourcePath: accountPaths.database,
        backupPath: backupDatabase,
        clonePath: candidateDatabase,
        expectedSourceSchema: sourceSchema,
        expectedTargetSchema: CURRENT_SCHEMA_VERSION,
        sentinelTables: ['schema_version'],
      });
      await chmod(candidateDatabase, 0o600);

      const candidateTargets: Record<ReleasePointerName, string> = {
        database: relative(dirname(accountPaths.database), candidateDatabase),
        configuration: await readlink(pointerPaths.configuration),
        generated: await readlink(pointerPaths.generated),
        application: relative(dirname(paths.appCurrent), release.releaseRoot),
      };
      const journalPath = join(paths.upgradeJournals, `${upgradeId}-activation.json`);
      const probe = createProductionConfigurationProbe({
        releaseRoot: release.releaseRoot,
        secretStore: this.dependencies.secretStore,
        detectCommand: this.dependencies.detectCommand,
      });
      const activation = new ReleasePointerTransaction({
        paths: pointerPaths,
        journalPath,
        afterSwitch: this.dependencies.afterSwitch,
        healthCheck: async () => {
          const probeResult = await probe(snapshot, { contentHash: snapshot.contentHash, files: {} });
          if (!probeResult.ok) {
            throw new Error(
              `candidate configuration probe failed: ${(probeResult.issues ?? []).join('; ')}`,
            );
          }
          verifyActiveDatabase(accountPaths.database);
        },
      });
      await activation.activate(candidateTargets);
      return { outcome: 'committed', upgradeId, journalPath };
    } finally {
      await lock.release();
    }
  }

  async rollback(releaseId: string): Promise<SourceNativeUpdateResult> {
    const paths = this.dependencies.paths;
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root);
    if (await this.dependencies.isServerRunning()) {
      throw new Error(
        'running Server must be quiesced through ServerUpdateCoordinator before rollback',
      );
    }
    const lock = await acquireRuntimeUpdateLock(paths.root, 'update');
    try {
      await new AccountLayoutMigrator({ paths }).migrate();
      await ensureRevisionedDatabasePointer(accountPaths);
      const pointerPaths = releasePointerPaths(paths, accountPaths);
      await recoverPreparedReleaseActivations(paths.upgradeJournals, pointerPaths);
      const currentApplication = await readlink(paths.appCurrent);
      const names = await readdir(paths.upgradeJournals)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
      let target: Awaited<ReturnType<typeof readReleaseActivationJournal>> | null = null;
      for (const name of names.filter(name => name.endsWith('-activation.json')).sort().reverse()) {
        const journal = await readReleaseActivationJournal(join(paths.upgradeJournals, name));
        if (
          journal.phase === 'committed'
          && journal.candidateTargets.application === currentApplication
          && basename(journal.previousTargets.application) === releaseId
        ) {
          target = journal;
          break;
        }
      }
      if (!target) {
        throw new Error(`rollback target was not previously verified compatible: ${releaseId}`);
      }

      const repository = new FileConfigurationRepository(accountPaths.config);
      await repository.initialize();
      await repository.recover();
      const targetRevision = basename(target.previousTargets.configuration);
      const targetSnapshot = await repository.readSnapshot(targetRevision);
      const targetReleaseRoot = resolve(dirname(paths.appCurrent), target.previousTargets.application);
      const probe = createProductionConfigurationProbe({
        releaseRoot: targetReleaseRoot,
        secretStore: this.dependencies.secretStore,
        detectCommand: this.dependencies.detectCommand,
      });
      const upgradeId = `rollback-${releaseId}-${randomUUID()}`;
      const currentRevision = basename(await readlink(pointerPaths.configuration));
      const service = new ConfigurationService({
        repository,
        createRevisionId: () => upgradeId,
        probe,
      });
      const draft = service.createDraft(targetSnapshot.config, currentRevision);
      const validation = service.validateDraft(draft.revisionId);
      if (!validation.ok) {
        throw new Error(
          `rollback configuration is invalid: ${validation.issues
            .map(issue => `${issue.path}: ${issue.message}`)
            .join('; ')}`,
        );
      }
      const compiledConfiguration = service.compileDraft(draft.revisionId);
      const configurationProbe = await service.probeDraft(draft.revisionId);
      if (!configurationProbe.ok) {
        throw new Error(
          `rollback configuration probe failed: ${(configurationProbe.issues ?? []).join('; ')}`,
        );
      }
      await repository.writeRevision({
        revisionId: upgradeId,
        contentHash: compiledConfiguration.contentHash,
        files: compiledConfiguration.files,
      });
      const compiledRuntime = await new ConfigurationCompiler(
        accountPaths.generatedAgentRuntime,
      ).compile({
        revisionId: upgradeId,
        contentHash: compiledConfiguration.contentHash,
        config: validation.config,
      });
      const rollbackSnapshot = await repository.readSnapshot(upgradeId);
      const rollbackTargets: Record<ReleasePointerName, string> = {
        ...target.previousTargets,
        configuration: relative(
          dirname(pointerPaths.configuration),
          join(accountPaths.configRevisions, upgradeId),
        ),
        generated: relative(dirname(accountPaths.generatedCurrent), compiledRuntime.rootPath),
      };
      const journalPath = join(paths.upgradeJournals, `${upgradeId}-activation.json`);
      const activation = new ReleasePointerTransaction({
        paths: pointerPaths,
        journalPath,
        afterSwitch: this.dependencies.afterSwitch,
        healthCheck: async () => {
          const probeResult = await probe(rollbackSnapshot, {
            contentHash: rollbackSnapshot.contentHash,
            files: {},
          });
          if (!probeResult.ok) {
            throw new Error(
              `rollback configuration probe failed: ${(probeResult.issues ?? []).join('; ')}`,
            );
          }
          verifyCompatibleDatabase(accountPaths.database);
        },
      });
      await activation.activate(rollbackTargets);
      return { outcome: 'committed', upgradeId, journalPath };
    } finally {
      await lock.release();
    }
  }
}

function releasePointerPaths(
  paths: AnyFusionPaths,
  accountPaths: AccountPaths,
): Record<ReleasePointerName, string> {
  return {
    database: accountPaths.database,
    configuration: accountPaths.configActive,
    generated: accountPaths.generatedCurrent,
    application: paths.appCurrent,
  };
}

async function ensureRevisionedDatabasePointer(accountPaths: AccountPaths): Promise<void> {
  const info = await lstat(accountPaths.database);
  if (info.isSymbolicLink()) return;
  if (!info.isFile()) {
    throw new Error(`account database is not a file or symlink: ${accountPaths.database}`);
  }
  verifyCompatibleDatabase(accountPaths.database);
  await mkdir(accountPaths.databaseRevisions, { recursive: true, mode: 0o700 });
  const baseline = join(
    accountPaths.databaseRevisions,
    `pre-revision-pointer-${randomUUID()}.db`,
  );
  await backupSqliteDatabase(accountPaths.database, baseline);
  await chmod(baseline, 0o600);
  verifyCompatibleDatabase(baseline);
  const temporary = `${accountPaths.database}.next-${randomUUID()}`;
  await symlink(relative(dirname(accountPaths.database), baseline), temporary);
  await rename(temporary, accountPaths.database);
}

async function backupSqliteDatabase(sourcePath: string, targetPath: string): Promise<void> {
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

function readSchemaVersion(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    } | undefined;
    if (!row || !Number.isInteger(row.version)) {
      throw new Error('database schema version is missing');
    }
    return row.version;
  } finally {
    db.close();
  }
}

function verifyActiveDatabase(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const version = db.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    } | undefined;
    if (version?.version !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`candidate database schema mismatch: ${version?.version ?? 'missing'}`);
    }
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error('candidate database integrity check failed');
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new Error('candidate database foreign key check failed');
    }
  } finally {
    db.close();
  }
}

function verifyCompatibleDatabase(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const version = db.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    } | undefined;
    if (
      version?.version !== 30
      && version?.version !== 31
      && version?.version !== 32
      && version?.version !== CURRENT_SCHEMA_VERSION
    ) {
      throw new Error(`rollback database schema is incompatible: ${version?.version ?? 'missing'}`);
    }
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error('rollback database integrity check failed');
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new Error('rollback database foreign key check failed');
    }
  } finally {
    db.close();
  }
}
