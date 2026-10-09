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
import { migrateLegacyProviderCredentials } from '../configuration/provider-credential-migration.js';
import type { CredentialsFileSecretStore } from '../configuration/credentials-file-secret-store.js';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../storage/migrations.js';
import { DatabaseUpgradeTransaction } from './database-upgrade-transaction.js';
import type { AnyFusionPaths } from './paths.js';
import { resolveReleasePaths } from './paths.js';
import {
  ReleasePointerTransaction,
  recoverPreparedReleaseActivations,
  readReleaseActivationJournal,
  type ReleaseActivationJournal,
  type ReleasePointerName,
} from './release-pointer-transaction.js';
import { createMigrationContextFromSnapshot } from './schema30-migration-context.js';
import { stageSourceRelease } from './source-native-installer.js';
import { AccountLayoutMigrator } from './account-layout-migrator.js';
import { acquireRuntimeUpdateLock } from './runtime-update-lock.js';
import { buildSourceMetadataPath, writeBuildSourceMetadata } from './build-source.js';
import { assertLauncherAvailable, installNativeLauncher } from './native-launcher.js';
import { backupGatewayJournal, restoreGatewayJournal } from './gateway-journal-backup.js';

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
    /**
     * Candidate probe store. It is the MetaWork credentials file, because the
     * probe must evaluate the configuration against the credentials the release
     * will actually read after activation.
     */
    secretStore: CredentialsFileSecretStore;
    detectCommand(command: string): Promise<boolean>;
    isServerRunning(): Promise<boolean>;
    afterSwitch?: (name: ReleasePointerName) => Promise<void>;
    installLaunchers?: boolean;
  }) {}

  /** Desktop helper crash recovery uses the same native activation and companion guards. */
  async recoverInterruptedActivation(): Promise<void> {
    if (await this.dependencies.isServerRunning()) throw new Error('Stop Server before activation recovery');
    const paths = this.dependencies.paths;
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root);
    const lock = await acquireRuntimeUpdateLock(paths.root, 'update');
    try {
      const pointers = releasePointerPaths(paths, accountPaths);
      await recoverPreparedReleaseActivations(paths.upgradeJournals, pointers,
        (journal, path) => restoreActivationJournal(accountPaths, journal, activationId(path)));
      const current = await findCurrentActivation(paths.upgradeJournals, pointers);
      const repository = new FileConfigurationRepository(accountPaths.config);
      await repository.initialize();
      await recoverConfiguration(repository, pointers, current);
    } finally { await lock.release(); }
  }

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
      await recoverPreparedReleaseActivations(paths.upgradeJournals, pointerPaths,
        (journal, path) => restoreActivationJournal(accountPaths, journal, activationId(path)));
      const currentActivation = await findCurrentActivation(paths.upgradeJournals, pointerPaths);
      const upgradeId = `update-${input.releaseId}-${randomUUID()}`;
      const release = resolveReleasePaths(paths.root, input.releaseId);
      const repository = new FileConfigurationRepository(accountPaths.config);
      await repository.initialize();
      await recoverConfiguration(repository, pointerPaths, currentActivation);
      const snapshot = await repository.getActiveSnapshot();

      // The one-time cutover to the credentials file runs during Server startup,
      // that is after activation, while the candidate probe below runs before
      // it. Migrate first so an installation that still keeps Provider keys in
      // the account secrets directory can satisfy the probe at all.
      await migrateLegacyProviderCredentials({
        target: this.dependencies.secretStore,
        providers: snapshot.config.providers,
        legacySecretsDir: accountPaths.secrets,
        env: process.env,
      });

      await stageSourceRelease(
        input.sourceRoot,
        input.plannerRoot,
        release.releaseRoot,
        input.releaseId,
        paths.appCurrent,
      );
      const sourceSchema = readSchemaVersion(accountPaths.database);
      if (!isSupportedDatabaseSchema(sourceSchema)) {
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
      await backupGatewayJournal({
        databasePath: accountPaths.database,
        journalRoot: join(accountPaths.gateway, 'events'),
        backupRoot: join(accountPaths.backups, upgradeId, 'gateway-events'),
      });

      const candidateTargets: Record<ReleasePointerName, string> = {
        database: relative(dirname(accountPaths.database), candidateDatabase),
        configuration: await readlink(pointerPaths.configuration),
        generated: await readlink(pointerPaths.generated),
        application: relative(dirname(paths.appCurrent), release.releaseRoot),
      };
      const journalPath = join(paths.upgradeJournals, `${upgradeId}-activation.json`);
      const probe = createProductionConfigurationProbe({
        checkExecutors: false,
        releaseRoot: release.releaseRoot,
        secretStore: this.dependencies.secretStore,
        detectCommand: this.dependencies.detectCommand,
      });
      const activation = new ReleasePointerTransaction({
        paths: pointerPaths,
        journalPath,
        previousActivationId: currentActivation?.upgradeId,
        beforeRollback: journal => restoreActivationJournal(accountPaths, journal, upgradeId),
        afterSwitch: this.dependencies.afterSwitch,
        healthCheck: async () => {
          const probeResult = await probe(snapshot, { contentHash: snapshot.contentHash, files: {} });
          if (!probeResult.ok) {
            throw Object.assign(new Error(
              `candidate configuration probe failed: ${(probeResult.issues ?? []).join('; ')}`,
            ), { code: 'configuration-invalid' });
          }
          verifyActiveDatabase(accountPaths.database);
        },
      });
      const launcherPaths = this.dependencies.installLaunchers === false ? [] : [
        paths.launcher,
        paths.anyFusionLauncher,
        paths.metaclawLauncher,
      ];
      await Promise.all(launcherPaths.map(assertLauncherAvailable));
      await Promise.all(
        launcherPaths.map(path => installNativeLauncher(path, paths.root)),
      );
      await writeBuildSourceMetadata(buildSourceMetadataPath(paths.root), {
        sourceRoot: input.sourceRoot,
        plannerRoot: input.plannerRoot,
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
      await recoverPreparedReleaseActivations(paths.upgradeJournals, pointerPaths,
        (journal, path) => restoreActivationJournal(accountPaths, journal, activationId(path)));
      const currentActivation = await findCurrentActivation(paths.upgradeJournals, pointerPaths);
      if (!currentActivation
        || basename(currentActivation.journal.previousTargets.application) !== releaseId) {
        throw new Error(`rollback target was not previously verified compatible: ${releaseId}`);
      }
      const target = currentActivation.journal;

      // The activation journal identifies the companion for this exact previous DB.
      // Restore before any pointer switch; current bodies are never removed.
      await restoreActivationJournal(accountPaths, target, currentActivation.upgradeId);

      const repository = new FileConfigurationRepository(accountPaths.config);
      await repository.initialize();
      await recoverConfiguration(repository, pointerPaths, currentActivation);
      const targetRevision = basename(target.previousTargets.configuration);
      const targetSnapshot = await repository.readSnapshot(targetRevision);
      // Rollback probes the target configuration before activation, so it needs
      // the same Provider credential migration the forward update performs.
      await migrateLegacyProviderCredentials({
        target: this.dependencies.secretStore,
        providers: targetSnapshot.config.providers,
        legacySecretsDir: accountPaths.secrets,
        env: process.env,
      });
      const targetReleaseRoot = resolve(dirname(paths.appCurrent), target.previousTargets.application);
      const probe = createProductionConfigurationProbe({
        checkExecutors: false,
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
      // A manual rollback is itself an activation; preserve its previous index too.
      await backupGatewayJournal({
        databasePath: accountPaths.database,
        journalRoot: join(accountPaths.gateway, 'events'),
        backupRoot: join(accountPaths.backups, upgradeId, 'gateway-events'),
      });
      const activation = new ReleasePointerTransaction({
        paths: pointerPaths,
        journalPath,
        previousActivationId: currentActivation.upgradeId,
        beforeRollback: journal => restoreActivationJournal(accountPaths, journal, upgradeId),
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
      // The current config transaction is already recovered and verified. Retire
      // it durably before the release transaction takes over its pointer, so both
      // crash recovery and ordinary Server startup accept either pointer set.
      await repository.journal.clear();
      await activation.activate(rollbackTargets);
      return { outcome: 'committed', upgradeId, journalPath };
    } finally {
      await lock.release();
    }
  }
}

interface CommittedActivation {
  upgradeId: string;
  journal: ReleaseActivationJournal;
}

function activationId(journalPath: string): string {
  return basename(journalPath).slice(0, -'-activation.json'.length);
}

async function restoreActivationJournal(
  accountPaths: AccountPaths,
  journal: ReleaseActivationJournal,
  upgradeId: string,
): Promise<void> {
  await restoreGatewayJournal({
    databasePath: resolve(dirname(accountPaths.database), journal.previousTargets.database),
    journalRoot: join(accountPaths.gateway, 'events'),
    backupRoot: join(accountPaths.backups, upgradeId, 'gateway-events'),
  });
}

async function findCurrentActivation(
  journalDirectory: string,
  paths: Record<ReleasePointerName, string>,
): Promise<CommittedActivation | null> {
  const names = await readdir(journalDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const activations: CommittedActivation[] = [];
  const pointerNames = Object.keys(paths) as ReleasePointerName[];
  for (const name of names.filter(name => name.endsWith('-activation.json'))) {
    const journal = await readReleaseActivationJournal(join(journalDirectory, name));
    if (journal.phase === 'committed'
      && pointerNames.every(key => journal.paths[key] === paths[key])) {
      activations.push({ upgradeId: activationId(name), journal });
    }
  }
  const sameTarget = (name: ReleasePointerName, left: string, right: string) =>
    resolve(dirname(paths[name]), left) === resolve(dirname(paths[name]), right);
  const currentDatabase = await readlink(paths.database);
  const currentApplication = await readlink(paths.application);
  // A rollback can revisit an app/DB pair. Only the unconsumed activation owns
  // its current checkpoint. Config/generated pointers may advance independently.
  const candidates = activations.filter(entry =>
    sameTarget('database', entry.journal.candidateTargets.database, currentDatabase)
    && sameTarget('application', entry.journal.candidateTargets.application, currentApplication)
    && !activations.some(next => next.upgradeId !== entry.upgradeId && (
      next.journal.previousActivationId === entry.upgradeId
      || (next.journal.previousActivationId === undefined && pointerNames.every(name =>
        sameTarget(name, next.journal.previousTargets[name], entry.journal.candidateTargets[name])))
    )));
  if (candidates.length > 1) {
    throw new Error('ambiguous committed release activation lineage');
  }
  return candidates[0] ?? null;
}

async function recoverConfiguration(
  repository: FileConfigurationRepository,
  paths: Record<ReleasePointerName, string>,
  activation: CommittedActivation | null,
): Promise<void> {
  const journal = await repository.journal.read();
  if (journal?.phase === 'committed' && activation) {
    const configuration = await readlink(paths.configuration);
    const generated = await readlink(paths.generated);
    const { previousTargets, candidateTargets } = activation.journal;
    // A committed release rollback supersedes the prior config-only journal.
    // Do not discard pending or independently advanced configuration activations.
    if (configuration === candidateTargets.configuration
      && generated === candidateTargets.generated
      && basename(configuration) !== journal.nextRevisionId
      && basename(previousTargets.configuration) === journal.nextRevisionId) {
      await repository.getActiveSnapshot();
      await repository.journal.clear();
    }
  }
  await repository.recover();
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
    if (!isSupportedDatabaseSchema(version?.version)) {
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

function isSupportedDatabaseSchema(version: number | undefined): boolean {
  return version !== undefined
    && Number.isInteger(version)
    && version >= 30
    && version <= CURRENT_SCHEMA_VERSION;
}
