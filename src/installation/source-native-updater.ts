import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readdir,
  readlink,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ConfigurationCompiler } from '../configuration/configuration-compiler.js';
import { ConfigurationService } from '../configuration/configuration-service.js';
import { createProductionConfigurationProbe } from '../configuration/production-configuration-probe.js';
import { FileConfigurationRepository } from '../configuration/file-configuration-repository.js';
import type { SecretStore } from '../configuration/secret-store.js';
import { runMigrations } from '../storage/migrations.js';
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
    if (await this.dependencies.isServerRunning()) {
      throw new Error(
        'running Server must be quiesced through ServerUpdateCoordinator before update',
      );
    }
    const paths = this.dependencies.paths;
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    const lockPath = join(paths.root, 'update.lock');
    const lock = await open(lockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') {
        throw new Error('another AnyFusion update transaction holds the update lock');
      }
      throw error;
    });
    try {
      const pointerPaths = releasePointerPaths(paths);
      await recoverPreparedReleaseActivations(paths.upgradeJournals, pointerPaths);
      const upgradeId = `update-${input.releaseId}-${randomUUID()}`;
      const release = resolveReleasePaths(paths.root, input.releaseId);
      const repository = new FileConfigurationRepository(dirname(paths.configurationRevisions));
      await repository.initialize();
      await repository.recover();
      const snapshot = await repository.getActiveSnapshot();

      await stageSourceRelease(input.sourceRoot, input.plannerRoot, release.releaseRoot);
      const sourceSchema = readSchemaVersion(paths.database);
      if (sourceSchema !== 30 && sourceSchema !== 31) {
        throw new Error(`unsupported update source schema: ${sourceSchema}`);
      }
      const candidateDatabase = join(paths.databaseRevisions, `${upgradeId}.db`);
      const backupDatabase = join(paths.backups, upgradeId, 'metaclaw.db');
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
        sourcePath: paths.database,
        backupPath: backupDatabase,
        clonePath: candidateDatabase,
        expectedSourceSchema: sourceSchema,
        expectedTargetSchema: 31,
        sentinelTables: ['schema_version'],
      });
      await chmod(candidateDatabase, 0o600);

      const candidateTargets: Record<ReleasePointerName, string> = {
        database: relative(dirname(paths.database), candidateDatabase),
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
          verifyActiveDatabase(paths.database);
        },
      });
      await activation.activate(candidateTargets);
      return { outcome: 'committed', upgradeId, journalPath };
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }

  async rollback(releaseId: string): Promise<SourceNativeUpdateResult> {
    if (await this.dependencies.isServerRunning()) {
      throw new Error(
        'running Server must be quiesced through ServerUpdateCoordinator before rollback',
      );
    }
    const paths = this.dependencies.paths;
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    const lockPath = join(paths.root, 'update.lock');
    const lock = await open(lockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') {
        throw new Error('another AnyFusion update transaction holds the update lock');
      }
      throw error;
    });
    try {
      const pointerPaths = releasePointerPaths(paths);
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

      const repository = new FileConfigurationRepository(dirname(paths.configurationRevisions));
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
        paths.generatedAgentRuntime,
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
          join(paths.configurationRevisions, upgradeId),
        ),
        generated: relative(dirname(paths.generatedCurrent), compiledRuntime.rootPath),
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
          verifyCompatibleDatabase(paths.database);
        },
      });
      await activation.activate(rollbackTargets);
      return { outcome: 'committed', upgradeId, journalPath };
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}

function releasePointerPaths(
  paths: AnyFusionPaths,
): Record<ReleasePointerName, string> {
  return {
    database: paths.database,
    configuration: join(dirname(paths.configurationRevisions), 'active'),
    generated: paths.generatedCurrent,
    application: paths.appCurrent,
  };
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
    if (version?.version !== 31) {
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
    if (version?.version !== 30 && version?.version !== 31) {
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
