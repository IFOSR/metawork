import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../../src/account/account-id.js';
import { resolveAccountPaths } from '../../src/account/account-paths.js';
import { FileSecretStore } from '../../src/configuration/file-secret-store.js';
import { CredentialsFileSecretStore } from '../../src/configuration/credentials-file-secret-store.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { resolveAnyFusionPaths } from '../../src/installation/paths.js';
import { SourceNativeInstaller } from '../../src/installation/source-native-installer.js';
import { SourceNativeUpdater } from '../../src/installation/source-native-updater.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/storage/migrations.js';
import Database from 'better-sqlite3';
import { createAccountEventJournal } from '../../src/server/account-event-journal.js';
import { ConfigurationService } from '../../src/configuration/configuration-service.js';
import { ConfigurationCompiler } from '../../src/configuration/configuration-compiler.js';
import { backupGatewayJournal } from '../../src/installation/gateway-journal-backup.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const root of cleanup.splice(0)) {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('SourceNativeUpdater', () => {
  it('preserves a model-free installation across update and rollback', async () => {
    const fixture = await installedFixture(false);
    const repository = new FileConfigurationRepository(fixture.accountPaths.config);
    const before = await repository.getActiveSnapshot();
    const sourceRoot = join(fixture.home, 'source-next');
    const plannerRoot = join(fixture.home, 'planner-next');
    fixtureRelease(sourceRoot, plannerRoot, 'next-runtime', 'next-planner');
    const updater = new SourceNativeUpdater({ paths: fixture.paths, secretStore: fixture.secretStore,
      detectCommand: async () => true, isServerRunning: async () => false });
    await updater.update({ releaseId: '1.2.1-preview.0', sourceRoot, plannerRoot });
    expect((await repository.getActiveSnapshot()).config.providers).toEqual({});
    expect((await repository.getActiveSnapshot()).config.models).toEqual({});
    await updater.rollback('1.2.0-preview.0');
    expect((await repository.getActiveSnapshot()).contentHash).toBe(before.contentHash);
  });
  it('lets the desktop helper recover a prepared native activation without staging another release', async () => {
    const fixture = await installedJournalFixture();
    const before = fixturePointers(fixture);
    const result = await fixture.updater.update(fixture.next);
    const activation = JSON.parse(readFileSync(result.journalPath, 'utf8'));
    activation.phase = 'prepared'; writeFileSync(result.journalPath, JSON.stringify(activation));
    await fixture.updater.recoverInterruptedActivation();
    expect(fixturePointers(fixture)).toEqual(before);
    await fixture.updater.recoverInterruptedActivation();
    expect(fixturePointers(fixture)).toEqual(before);
  });
  it.each([
    ['update', 'update'], ['update', 'rollback'],
    ['rollback', 'update'], ['rollback', 'rollback'],
  ] as const)('restores prepared %s activation bodies before %s recovery switches pointers', async (interrupted, operation) => {
    const fixture = await installedJournalFixture();
    let update = await fixture.updater.update(fixture.next);
    if (interrupted === 'rollback') update = await fixture.updater.rollback('1.2.0-preview.0');
    await withJournal(fixture.accountPaths, async journal => {
      await journal.compact(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup');
    });
    const activation = JSON.parse(readFileSync(update.journalPath, 'utf8'));
    activation.phase = 'prepared';
    writeFileSync(update.journalPath, JSON.stringify(activation));

    if (operation === 'update') {
      await fixture.updater.update({ ...fixture.next, releaseId: '1.2.2-preview.0' });
    } else {
      // Stop after recovery rather than activate another release.
      await expect(fixture.updater.rollback('never-installed')).rejects.toThrow('not previously verified');
    }
    await withJournal(fixture.accountPaths, async journal => {
      expect((await journal.replay(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup')).deltas.map(row => row.eventId))
        .toEqual(['event_1', 'event_2', 'event_3']);
    });
    expect(() => readFileSync(update.journalPath)).toThrow();
  });

  it.each([
    ['update', 'update', 'missing'], ['update', 'update', 'corrupt'],
    ['update', 'rollback', 'missing'], ['update', 'rollback', 'corrupt'],
    ['rollback', 'update', 'missing'], ['rollback', 'update', 'corrupt'],
    ['rollback', 'rollback', 'missing'], ['rollback', 'rollback', 'corrupt'],
  ] as const)('fails closed for prepared %s during %s recovery with a %s companion', async (interrupted, operation, fault) => {
    const fixture = await installedJournalFixture();
    let update = await fixture.updater.update(fixture.next);
    if (interrupted === 'rollback') update = await fixture.updater.rollback('1.2.0-preview.0');
    await withJournal(fixture.accountPaths, async journal => {
      await journal.compact(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup');
    });
    const activation = JSON.parse(readFileSync(update.journalPath, 'utf8'));
    activation.phase = 'prepared';
    writeFileSync(update.journalPath, JSON.stringify(activation));
    const backup = join(fixture.accountPaths.backups, update.upgradeId, 'gateway-events');
    if (fault === 'missing') rmSync(backup, { recursive: true });
    else writeFileSync(join(backup, 'complete.json'), '{}');
    const before = fixturePointers(fixture);
    await expect(operation === 'update'
      ? fixture.updater.update({ ...fixture.next, releaseId: '1.2.2-preview.0' })
      : fixture.updater.rollback('1.2.0-preview.0')).rejects.toThrow();
    expect(fixturePointers(fixture)).toEqual(before);
    expect(JSON.parse(readFileSync(update.journalPath, 'utf8')).phase).toBe('prepared');
  });

  it.each(['update', 'rollback'] as const)('restores bodies before inline %s failure rolls pointers back', async operation => {
    const fixture = await installedJournalFixture();
    if (operation === 'rollback') await fixture.updater.update(fixture.next);
    const before = fixturePointers(fixture);
    const updater = new SourceNativeUpdater({
      paths: fixture.paths, secretStore: fixture.secretStore,
      detectCommand: async command => command === 'codex', isServerRunning: async () => false,
      afterSwitch: async name => {
        if (name !== 'application') return;
        await withJournal(fixture.accountPaths, async journal => {
          await journal.compact(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup');
        });
        throw new Error('candidate startup failed after compaction');
      },
    });
    await expect(operation === 'update'
      ? updater.update(fixture.next)
      : updater.rollback('1.2.0-preview.0')).rejects.toThrow('candidate startup failed after compaction');
    expect(fixturePointers(fixture)).toEqual(before);
    await withJournal(fixture.accountPaths, async journal => {
      expect((await journal.replay(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup')).deltas.map(row => row.eventId))
        .toEqual(['event_1', 'event_2', 'event_3']);
    });
  });

  it.each([false, true])('uses committed lineage across repeated rollback and compaction (independent config: %s)', async changeConfig => {
    const fixture = await installedJournalFixture();
    await fixture.updater.update(fixture.next);
    await withJournal(fixture.accountPaths, async journal => {
      await journal.append(journalEvent(4));
      await journal.compact(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup');
    });
    await fixture.updater.rollback('1.2.0-preview.0');
    await withJournal(fixture.accountPaths, async journal => {
      await journal.append(journalEvent(5));
      await journal.compact(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup');
    });
    if (changeConfig) await independentlyActivateConfiguration(fixture, 'config-after-first-rollback');
    await fixture.updater.rollback('1.2.1-preview.0');
    await withJournal(fixture.accountPaths, async journal => {
      expect((await journal.replay(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup')).deltas.map(row => row.eventId))
        .toEqual(['event_1', 'event_2', 'event_3', 'event_4']);
      await journal.append(journalEvent(6));
      await journal.compact(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup');
    });
    if (changeConfig) await independentlyActivateConfiguration(fixture, 'config-after-second-rollback');
    await fixture.updater.rollback('1.2.0-preview.0');
    await withJournal(fixture.accountPaths, async journal => {
      expect((await journal.replay(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup')).deltas.map(row => row.eventId))
        .toEqual(['event_1', 'event_2', 'event_3', 'event_5']);
    });
    await fixture.updater.rollback('1.2.1-preview.0');
    await withJournal(fixture.accountPaths, async journal => {
      expect((await journal.replay(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup')).deltas.map(row => row.eventId))
        .toEqual(['event_1', 'event_2', 'event_3', 'event_4', 'event_6']);
    });
  });

  it('allows another release rollback without an obsolete configuration journal blocking it', async () => {
    const fixture = await installedJournalFixture();
    await fixture.updater.update(fixture.next);
    const configJournal = new FileConfigurationRepository(fixture.accountPaths.config).journal.path;
    const legacyJournal = readFileSync(configJournal);
    await fixture.updater.rollback('1.2.0-preview.0');
    // Releases predating config-journal retirement left this committed record behind.
    writeFileSync(configJournal, legacyJournal);
    await expect(fixture.updater.rollback('1.2.1-preview.0'))
      .resolves.toMatchObject({ outcome: 'committed' });
  });

  it('leaves configuration recovery healthy immediately after release rollback', async () => {
    const fixture = await installedJournalFixture();
    await fixture.updater.update(fixture.next);
    await fixture.updater.rollback('1.2.0-preview.0');
    await expect(new FileConfigurationRepository(fixture.accountPaths.config).recover())
      .resolves.toMatchObject({ status: 'healthy' });
  });

  it('allows update after rollback supersedes the old configuration activation journal', async () => {
    const fixture = await installedJournalFixture();
    await fixture.updater.update(fixture.next);
    await fixture.updater.rollback('1.2.0-preview.0');
    await expect(fixture.updater.update({ ...fixture.next, releaseId: '1.2.2-preview.0' }))
      .resolves.toMatchObject({ outcome: 'committed' });
  });

  it('does not select a journal for the same application but a different database', async () => {
    const fixture = await installedJournalFixture();
    const update = await fixture.updater.update(fixture.next);
    const activation = JSON.parse(readFileSync(update.journalPath, 'utf8'));
    activation.candidateTargets.database = 'database-revisions/not-current.db';
    writeFileSync(update.journalPath, JSON.stringify(activation));
    const before = fixturePointers(fixture);
    await expect(fixture.updater.rollback('1.2.0-preview.0')).rejects.toThrow('not previously verified');
    expect(fixturePointers(fixture)).toEqual(before);
  });

  it('rejects ambiguous committed lineage without relying on filenames', async () => {
    const fixture = await installedJournalFixture();
    const update = await fixture.updater.update(fixture.next);
    writeFileSync(join(fixture.paths.upgradeJournals, 'zzz-duplicate-activation.json'),
      readFileSync(update.journalPath));
    const before = fixturePointers(fixture);
    await expect(fixture.updater.rollback('1.2.0-preview.0')).rejects.toThrow('ambiguous');
    expect(fixturePointers(fixture)).toEqual(before);
  });

  it('restores companion segments before switching to the previous database after compaction', async () => {
    const fixture = await installedJournalFixture();
    const originalDb = readlinkSync(fixture.accountPaths.database);
    const before = readFileSync(fixture.accountPaths.database);
    const update = await fixture.updater.update(fixture.next);
    const manifest = join(fixture.accountPaths.backups, update.upgradeId, 'gateway-events', 'complete.json');
    expect(JSON.parse(readFileSync(manifest, 'utf8')).version).toBe(1);
    expect(readFileSync(resolve(dirname(fixture.accountPaths.database), originalDb))).toEqual(before);
    await withJournal(fixture.accountPaths, async journal => {
      await journal.compact(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup');
      await journal.append(journalEvent(4));
    });
    const directory = join(fixture.accountPaths.gateway, 'events', LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup.segments');
    const currentFiles = readdirSync(directory);
    await fixture.updater.rollback('1.2.0-preview.0');
    expect(readlinkSync(fixture.accountPaths.database)).toBe(originalDb);
    await withJournal(fixture.accountPaths, async journal => {
      const replay = await journal.replay(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_backup');
      expect(replay.deltas.map(row => row.eventId)).toEqual(['event_1', 'event_2', 'event_3']);
    });
    for (const file of currentFiles) expect(readdirSync(directory)).toContain(file);
  });

  it.each(['missing', 'corrupt'] as const)('aborts rollback before pointer changes when the companion is %s', async fault => {
    const fixture = await installedJournalFixture();
    const update = await fixture.updater.update(fixture.next);
    const pointers = () => [
      fixture.accountPaths.database, fixture.accountPaths.configActive,
      fixture.accountPaths.generatedCurrent, fixture.paths.appCurrent,
    ].map(path => readlinkSync(path));
    const before = pointers();
    const backup = join(fixture.accountPaths.backups, update.upgradeId, 'gateway-events');
    if (fault === 'missing') rmSync(backup, { recursive: true });
    else {
      const manifest = JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8'));
      writeFileSync(join(backup, manifest.segments[0].path), 'corrupt');
    }
    await expect(fixture.updater.rollback('1.2.0-preview.0')).rejects.toThrow();
    expect(pointers()).toEqual(before);
  });

  it('backs up and clones the database, then activates one complete candidate set', async () => {
    const fixture = await installedFixture();
    writeFileSync(
      fixture.paths.launcher,
      '#!/usr/bin/env bash\n# MetaWork managed launcher\nexec node old-runtime.js "$@"\n',
      { mode: 0o755 },
    );
    seedWorkspaceConversationState(fixture.accountPaths);
    const previousDatabaseTarget = readlinkSync(fixture.accountPaths.database);
    const previousConfigurationTarget = readlinkSync(fixture.accountPaths.configActive);
    const previousGeneratedTarget = readlinkSync(fixture.accountPaths.generatedCurrent);
    const nextSource = join(fixture.home, 'source-next');
    const nextPlanner = join(fixture.home, 'planner-next');
    fixtureRelease(nextSource, nextPlanner, 'runtime-next\n', 'planner-next\n');
    const updater = new SourceNativeUpdater({
      paths: fixture.paths,
      secretStore: fixture.secretStore,
      detectCommand: async command => command === 'codex',
      isServerRunning: async () => false,
    });

    const result = await updater.update({
      releaseId: '1.2.1-preview.0',
      sourceRoot: nextSource,
      plannerRoot: nextPlanner,
    });

    expect(result.outcome).toBe('committed');
    expect(readFileSync(join(fixture.paths.appCurrent, 'dist', 'index.js'), 'utf8'))
      .toBe('runtime-next\n');
    expect(readFileSync(fixture.paths.launcher, 'utf8')).toContain('METAWORK_RELEASE_ID');
    expect(JSON.parse(readFileSync(
      join(fixture.paths.appCurrent, 'release-identity.json'),
      'utf8',
    ))).toMatchObject({ releaseId: '1.2.1-preview.0', gatewayProtocolVersion: 2 });
    expect(JSON.parse(readFileSync(join(fixture.paths.root, 'build-source.json'), 'utf8')))
      .toMatchObject({ sourceRoot: nextSource, plannerRoot: nextPlanner });
    expect(readlinkSync(fixture.accountPaths.database)).not.toBe(previousDatabaseTarget);
    expect(readlinkSync(fixture.accountPaths.configActive))
      .toBe(previousConfigurationTarget);
    expect(readlinkSync(fixture.accountPaths.generatedCurrent)).toBe(previousGeneratedTarget);
    expectWorkspaceConversationState(fixture.accountPaths);
    expect(() => readlinkSync(fixture.paths.database)).toThrow();
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8')) as {
      phase: string;
    };
    expect(journal.phase).toBe('committed');
  });

  it('normalizes a previously migrated regular account database before update', async () => {
    const fixture = await installedFixture();
    const activeTarget = resolve(
      dirname(fixture.accountPaths.database),
      readlinkSync(fixture.accountPaths.database),
    );
    const databaseBytes = readFileSync(activeTarget);
    rmSync(fixture.accountPaths.database);
    writeFileSync(fixture.accountPaths.database, databaseBytes);

    const nextSource = join(fixture.home, 'source-normalized-next');
    const nextPlanner = join(fixture.home, 'planner-normalized-next');
    fixtureRelease(nextSource, nextPlanner, 'runtime-normalized\n', 'planner-normalized\n');
    await new SourceNativeUpdater({
      paths: fixture.paths,
      secretStore: fixture.secretStore,
      detectCommand: async command => command === 'codex',
      isServerRunning: async () => false,
    }).update({
      releaseId: '1.2.1-preview.0',
      sourceRoot: nextSource,
      plannerRoot: nextPlanner,
    });

    expect(lstatSync(fixture.accountPaths.database).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(fixture.paths.appCurrent, 'dist', 'index.js'), 'utf8'))
      .toBe('runtime-normalized\n');
  });

  it('preserves committed WAL data while normalizing a regular account database', async () => {
    const fixture = await installedFixture();
    const activeTarget = resolve(
      dirname(fixture.accountPaths.database),
      readlinkSync(fixture.accountPaths.database),
    );
    const databaseBytes = readFileSync(activeTarget);
    rmSync(fixture.accountPaths.database);
    writeFileSync(fixture.accountPaths.database, databaseBytes);
    const writer = new (await import('better-sqlite3')).default(
      fixture.accountPaths.database,
    );
    const nextSource = join(fixture.home, 'source-wal-next');
    const nextPlanner = join(fixture.home, 'planner-wal-next');
    fixtureRelease(nextSource, nextPlanner, 'runtime-wal\n', 'planner-wal\n');

    try {
      writer.pragma('journal_mode = WAL');
      writer.pragma('wal_autocheckpoint = 0');
      writer.exec('CREATE TABLE updater_wal_probe (value TEXT NOT NULL)');
      writer.prepare('INSERT INTO updater_wal_probe (value) VALUES (?)').run('committed-in-wal');
      expect(lstatSync(`${fixture.accountPaths.database}-wal`).size).toBeGreaterThan(0);

      await new SourceNativeUpdater({
        paths: fixture.paths,
        secretStore: fixture.secretStore,
        detectCommand: async command => command === 'codex',
        isServerRunning: async () => false,
      }).update({
        releaseId: '1.2.1-preview.0',
        sourceRoot: nextSource,
        plannerRoot: nextPlanner,
      });

      const migrated = new (await import('better-sqlite3')).default(
        fixture.accountPaths.database,
        { readonly: true, fileMustExist: true },
      );
      try {
        expect(migrated.prepare('SELECT value FROM updater_wal_probe').get())
          .toEqual({ value: 'committed-in-wal' });
      } finally {
        migrated.close();
      }
    } finally {
      writer.close();
    }
  });

  it('updates a schema 34 database through every supported migration', async () => {
    const fixture = await installedFixture();
    const sourceDatabase = new (await import('better-sqlite3')).default(
      fixture.accountPaths.database,
    );
    try {
      sourceDatabase.prepare('UPDATE schema_version SET version = 34').run();
    } finally {
      sourceDatabase.close();
    }
    const nextSource = join(fixture.home, 'source-schema-34-next');
    const nextPlanner = join(fixture.home, 'planner-schema-34-next');
    fixtureRelease(nextSource, nextPlanner, 'runtime-schema-34\n', 'planner-schema-34\n');

    await new SourceNativeUpdater({
      paths: fixture.paths,
      secretStore: fixture.secretStore,
      detectCommand: async command => command === 'codex',
      isServerRunning: async () => false,
    }).update({
      releaseId: '1.2.1-preview.0',
      sourceRoot: nextSource,
      plannerRoot: nextPlanner,
    });

    const migrated = new (await import('better-sqlite3')).default(
      fixture.accountPaths.database,
      { readonly: true, fileMustExist: true },
    );
    try {
      expect(migrated.prepare('SELECT version FROM schema_version').get())
        .toEqual({ version: CURRENT_SCHEMA_VERSION });
    } finally {
      migrated.close();
    }
  });

  it('fails closed before staging when a daemon is still running', async () => {
    const fixture = await installedFixture();
    const nextSource = join(fixture.home, 'source-blocked');
    const nextPlanner = join(fixture.home, 'planner-blocked');
    fixtureRelease(nextSource, nextPlanner, 'blocked\n', 'blocked\n');
    const updater = new SourceNativeUpdater({
      paths: fixture.paths,
      secretStore: fixture.secretStore,
      detectCommand: async () => true,
      isServerRunning: async () => true,
    });

    await expect(updater.update({
      releaseId: '1.2.1-preview.0',
      sourceRoot: nextSource,
      plannerRoot: nextPlanner,
    })).rejects.toThrow('running Server must be quiesced');

    expect(readFileSync(join(fixture.paths.appCurrent, 'dist', 'index.js'), 'utf8'))
      .toBe('runtime-initial\n');
  });

  it('fails closed when the atomic runtime-update lock is held by runtime', async () => {
    const fixture = await installedFixture();
    const nextSource = join(fixture.home, 'source-runtime-locked');
    const nextPlanner = join(fixture.home, 'planner-runtime-locked');
    fixtureRelease(nextSource, nextPlanner, 'blocked\n', 'blocked\n');
    mkdirSync(fixture.paths.data, { recursive: true });
    writeFileSync(
      join(fixture.paths.data, 'runtime.lock'),
      `${JSON.stringify({
        pid: String(process.pid),
        startedAt: '2026-08-19T00:00:00.000Z',
      })}\n`,
    );

    await expect(new SourceNativeUpdater({
      paths: fixture.paths,
      secretStore: fixture.secretStore,
      detectCommand: async () => true,
      isServerRunning: async () => false,
    }).update({
      releaseId: '1.2.1-preview.0',
      sourceRoot: nextSource,
      plannerRoot: nextPlanner,
    })).rejects.toThrow('runtime holds the runtime/update lock');

    expect(readFileSync(join(fixture.paths.appCurrent, 'dist', 'index.js'), 'utf8'))
      .toBe('runtime-initial\n');
  });

  it('rolls back to the exact previously journaled compatible pointer set', async () => {
    const fixture = await installedFixture();
    seedWorkspaceConversationState(fixture.accountPaths);
    const initialTargets = {
      database: readlinkSync(fixture.accountPaths.database),
      configuration: readlinkSync(fixture.accountPaths.configActive),
      generated: readlinkSync(fixture.accountPaths.generatedCurrent),
      application: readlinkSync(fixture.paths.appCurrent),
    };
    const nextSource = join(fixture.home, 'source-rollback-next');
    const nextPlanner = join(fixture.home, 'planner-rollback-next');
    fixtureRelease(nextSource, nextPlanner, 'runtime-next\n', 'planner-next\n');
    const updater = new SourceNativeUpdater({
      paths: fixture.paths,
      secretStore: fixture.secretStore,
      detectCommand: async command => command === 'codex',
      isServerRunning: async () => false,
    });
    await updater.update({
      releaseId: '1.2.1-preview.0',
      sourceRoot: nextSource,
      plannerRoot: nextPlanner,
    });

    const result = await updater.rollback('1.2.0-preview.0');

    expect(result.outcome).toBe('committed');
    expect(readlinkSync(fixture.accountPaths.database)).toBe(initialTargets.database);
    expect(readlinkSync(fixture.paths.appCurrent)).toBe(initialTargets.application);
    expect(readlinkSync(fixture.accountPaths.configActive))
      .not.toBe(initialTargets.configuration);
    expect(readlinkSync(fixture.accountPaths.generatedCurrent)).not.toBe(initialTargets.generated);
    expect(readFileSync(join(fixture.paths.appCurrent, 'dist', 'index.js'), 'utf8'))
      .toBe('runtime-initial\n');
    expectWorkspaceConversationState(fixture.accountPaths);
    const repository = new FileConfigurationRepository(fixture.accountPaths.config);
    const rollbackSnapshot = await repository.getActiveSnapshot();
    const originalSnapshot = await repository.readSnapshot(
      initialTargets.configuration.split('/').at(-1)!,
    );
    expect(rollbackSnapshot.revisionId).toMatch(/^rollback-1\.2\.0-preview\.0-/u);
    expect(rollbackSnapshot.contentHash).toBe(originalSnapshot.contentHash);
  });

  it('recovers an earlier prepared activation journal before starting a new update', async () => {
    const fixture = await installedFixture();
    await backupGatewayJournal({
      databasePath: fixture.accountPaths.database,
      journalRoot: join(fixture.accountPaths.gateway, 'events'),
      backupRoot: join(fixture.accountPaths.backups, 'update-interrupted', 'gateway-events'),
    });
    const previousTargets = {
      database: readlinkSync(fixture.accountPaths.database),
      configuration: readlinkSync(fixture.accountPaths.configActive),
      generated: readlinkSync(fixture.accountPaths.generatedCurrent),
      application: readlinkSync(fixture.paths.appCurrent),
    };
    const interruptedDatabase = join(fixture.accountPaths.databaseRevisions, 'interrupted.db');
    writeFileSync(interruptedDatabase, 'not-a-database');
    rmSync(fixture.accountPaths.database);
    symlinkSync(
      join('database-revisions', 'interrupted.db'),
      fixture.accountPaths.database,
    );
    const interruptedJournal = join(
      fixture.paths.upgradeJournals,
      'update-interrupted-activation.json',
    );
    mkdirSync(fixture.paths.upgradeJournals, { recursive: true });
    writeFileSync(interruptedJournal, `${JSON.stringify({
      schemaVersion: 1,
      phase: 'prepared',
      paths: {
        database: fixture.accountPaths.database,
        configuration: fixture.accountPaths.configActive,
        generated: fixture.accountPaths.generatedCurrent,
        application: fixture.paths.appCurrent,
      },
      previousTargets,
      candidateTargets: {
        ...previousTargets,
        database: join('database-revisions', 'interrupted.db'),
      },
    }, null, 2)}\n`);

    const nextSource = join(fixture.home, 'source-recovered-next');
    const nextPlanner = join(fixture.home, 'planner-recovered-next');
    fixtureRelease(nextSource, nextPlanner, 'runtime-recovered\n', 'planner-recovered\n');
    const updater = new SourceNativeUpdater({
      paths: fixture.paths,
      secretStore: fixture.secretStore,
      detectCommand: async command => command === 'codex',
      isServerRunning: async () => false,
    });

    await updater.update({
      releaseId: '1.2.1-preview.0',
      sourceRoot: nextSource,
      plannerRoot: nextPlanner,
    });

    expect(() => readFileSync(interruptedJournal)).toThrow();
    expect(readFileSync(join(fixture.paths.appCurrent, 'dist', 'index.js'), 'utf8'))
      .toBe('runtime-recovered\n');
  });

  it('migrates legacy account secrets before probing an update from an older release', async () => {
    const fixture = await installedFixture();
    // Reproduce an installation created before the MetaWork credentials file:
    // the Provider key exists only in the account-scoped secrets directory.
    const legacyStore = new FileSecretStore(fixture.accountPaths.secrets);
    await legacyStore.initialize();
    await legacyStore.put('file-secret:anyfusion/provider', 'legacy-provider-key');
    const credentialsFile = join(fixture.paths.root, 'credentials.json');
    rmSync(credentialsFile, { force: true });

    const nextSource = join(fixture.home, 'source-legacy-next');
    const nextPlanner = join(fixture.home, 'planner-legacy-next');
    fixtureRelease(nextSource, nextPlanner, 'runtime-legacy-next\n', 'planner-legacy-next\n');
    const updater = new SourceNativeUpdater({
      paths: fixture.paths,
      secretStore: new CredentialsFileSecretStore(credentialsFile),
      detectCommand: async command => command === 'codex',
      isServerRunning: async () => false,
    });

    await expect(updater.update({
      releaseId: '1.2.1-preview.0',
      sourceRoot: nextSource,
      plannerRoot: nextPlanner,
    })).resolves.toMatchObject({ outcome: 'committed' });

    expect(JSON.parse(readFileSync(credentialsFile, 'utf8'))).toEqual({
      version: 1,
      providers: { provider: 'legacy-provider-key' },
    });
    expect(readFileSync(join(fixture.paths.appCurrent, 'dist', 'index.js'), 'utf8'))
      .toBe('runtime-legacy-next\n');
  });

  it('migrates legacy account secrets before probing a rollback to an older release', async () => {
    const fixture = await installedFixture();
    const nextSource = join(fixture.home, 'source-rollback-legacy');
    const nextPlanner = join(fixture.home, 'planner-rollback-legacy');
    fixtureRelease(nextSource, nextPlanner, 'runtime-rollback-legacy\n', 'planner-rollback-legacy\n');
    const updater = new SourceNativeUpdater({
      paths: fixture.paths,
      secretStore: fixture.secretStore,
      detectCommand: async command => command === 'codex',
      isServerRunning: async () => false,
    });
    await updater.update({
      releaseId: '1.2.1-preview.0',
      sourceRoot: nextSource,
      plannerRoot: nextPlanner,
    });

    // The rollback target predates the credentials file, so restore the legacy
    // layout an older installation would have had.
    const credentialsFile = join(fixture.paths.root, 'credentials.json');
    rmSync(credentialsFile, { force: true });
    const legacyStore = new FileSecretStore(fixture.accountPaths.secrets);
    await legacyStore.initialize();
    await legacyStore.put('file-secret:anyfusion/provider', 'legacy-provider-key');

    await expect(updater.rollback('1.2.0-preview.0'))
      .resolves.toMatchObject({ outcome: 'committed' });

    expect(JSON.parse(readFileSync(credentialsFile, 'utf8'))).toEqual({
      version: 1,
      providers: { provider: 'legacy-provider-key' },
    });
    expect(readFileSync(join(fixture.paths.appCurrent, 'dist', 'index.js'), 'utf8'))
      .toBe('runtime-initial\n');
  });

  it('replaces an orphaned staged release directory left by a rolled-back update', async () => {
    const fixture = await installedFixture();
    const orphan = join(fixture.paths.releases, '1.2.1-preview.0');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'dist'), 'stale\n');

    const nextSource = join(fixture.home, 'source-orphan-next');
    const nextPlanner = join(fixture.home, 'planner-orphan-next');
    fixtureRelease(nextSource, nextPlanner, 'runtime-orphan-next\n', 'planner-orphan-next\n');
    const updater = new SourceNativeUpdater({
      paths: fixture.paths,
      secretStore: fixture.secretStore,
      detectCommand: async command => command === 'codex',
      isServerRunning: async () => false,
    });

    await expect(updater.update({
      releaseId: '1.2.1-preview.0',
      sourceRoot: nextSource,
      plannerRoot: nextPlanner,
    })).resolves.toMatchObject({ outcome: 'committed' });

    expect(readFileSync(join(fixture.paths.appCurrent, 'dist', 'index.js'), 'utf8'))
      .toBe('runtime-orphan-next\n');
  });
});

function journalEvent(n: number): import('../../src/gateway/client-events.js').GatewayEventEnvelope {
  return {
    protocolVersion: 2, accountId: LOCAL_DEFAULT_ACCOUNT_ID, conversationId: 'conv_backup',
    eventId: `event_${n}`, requestId: null, turnId: `turn_${n}`, sequence: 0,
    kind: 'final_answer', payload: { lines: [`Answer ${n}`] }, occurredAt: '2026-09-27T00:00:00Z',
  };
}

function fixturePointers(fixture: Awaited<ReturnType<typeof installedFixture>>) {
  return [
    fixture.accountPaths.database, fixture.accountPaths.configActive,
    fixture.accountPaths.generatedCurrent, fixture.paths.appCurrent,
  ].map(path => readlinkSync(path));
}

async function independentlyActivateConfiguration(
  fixture: Awaited<ReturnType<typeof installedFixture>>,
  revisionId: string,
) {
  const repository = new FileConfigurationRepository(fixture.accountPaths.config);
  const snapshot = await repository.getActiveSnapshot();
  const service = new ConfigurationService({
    repository, createRevisionId: () => revisionId,
    probe: async () => ({ ok: true }),
  });
  const draft = service.createDraft(snapshot.config, snapshot.revisionId);
  expect(service.validateDraft(draft.revisionId).ok).toBe(true);
  const compiled = service.compileDraft(draft.revisionId);
  await repository.writeRevision({ revisionId, contentHash: compiled.contentHash, files: compiled.files });
  const runtime = await new ConfigurationCompiler(fixture.accountPaths.generatedAgentRuntime)
    .compile({ revisionId, contentHash: compiled.contentHash, config: snapshot.config });
  await repository.activateRevision(revisionId, snapshot.revisionId);
  rmSync(fixture.accountPaths.generatedCurrent);
  symlinkSync(runtime.rootPath, fixture.accountPaths.generatedCurrent);
}

async function withJournal(
  paths: ReturnType<typeof resolveAccountPaths>,
  action: (journal: ReturnType<typeof createAccountEventJournal>['journal']) => Promise<void>,
) {
  const db = new Database(paths.database);
  const runtime = createAccountEventJournal({
    db, root: join(paths.gateway, 'events'), accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    onError: error => { throw error; },
  });
  try { await action(runtime.journal); }
  finally { await runtime.stop(); db.close(); }
}

async function installedJournalFixture() {
  const fixture = await installedFixture();
  await withJournal(fixture.accountPaths, async journal => {
    for (const n of [1, 2, 3]) await journal.append(journalEvent(n));
  });
  const sourceRoot = join(fixture.home, 'source-journal-next');
  const plannerRoot = join(fixture.home, 'planner-journal-next');
  fixtureRelease(sourceRoot, plannerRoot, 'runtime-journal\n', 'planner-journal\n');
  return {
    ...fixture,
    updater: new SourceNativeUpdater({
      paths: fixture.paths, secretStore: fixture.secretStore,
      detectCommand: async command => command === 'codex', isServerRunning: async () => false,
    }),
    next: { releaseId: '1.2.1-preview.0', sourceRoot, plannerRoot },
  };
}

async function installedFixture(configured = true) {
  const home = mkdtempSync(join(tmpdir(), 'anyfusion-source-update-'));
  cleanup.push(home);
  const sourceRoot = join(home, 'source-initial');
  const plannerRoot = join(home, 'planner-initial');
  fixtureRelease(sourceRoot, plannerRoot, 'runtime-initial\n', 'planner-initial\n');
  const paths = resolveAnyFusionPaths(home);
  const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root);
  const secretStore = new CredentialsFileSecretStore(join(paths.root, 'credentials.json'));
  await new SourceNativeInstaller({
    paths,
    secretStore,
    detectCommand: async command => command === 'codex',
  }).install({
    releaseId: '1.2.0-preview.0',
    sourceRoot,
    plannerRoot,
    provider: configured ? {
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      modelId: 'model',
      region: 'international',
      secretReference: 'file-secret:anyfusion/provider',
    } : undefined,
  });
  return { home, paths, accountPaths, secretStore };
}

function fixtureRelease(
  sourceRoot: string,
  plannerRoot: string,
  runtime: string,
  planner: string,
): void {
  mkdirSync(join(sourceRoot, 'dist'), { recursive: true });
  mkdirSync(join(sourceRoot, 'node_modules'), { recursive: true });
  writeFileSync(join(sourceRoot, 'dist', 'index.js'), runtime);
  writeFileSync(join(sourceRoot, 'package.json'), '{"name":"anyfusion"}\n');
  mkdirSync(join(sourceRoot, 'web', 'dist'), { recursive: true });
  writeFileSync(join(sourceRoot, 'web', 'dist', 'index.html'), 'web\n');
  mkdirSync(join(plannerRoot, 'packages', 'coding-agent', 'dist'), { recursive: true });
  mkdirSync(join(plannerRoot, 'node_modules'), { recursive: true });
  writeFileSync(join(plannerRoot, 'packages', 'coding-agent', 'dist', 'cli.js'), planner);
  writeFileSync(join(plannerRoot, 'package.json'), '{"name":"anyfusion-pi"}\n');
}

function makeWritable(path: string): void {
  try {
    const entry = lstatSync(path);
    if (entry.isDirectory()) {
      chmodSync(path, 0o700);
      for (const child of readdirSync(path)) makeWritable(join(path, child));
    } else if (!entry.isSymbolicLink()) {
      chmodSync(path, 0o600);
    }
  } catch {
    return;
  }
}

function seedWorkspaceConversationState(
  accountPaths: ReturnType<typeof resolveAccountPaths>,
): void {
  mkdirSync(accountPaths.workspaceCatalog, { recursive: true });
  writeFileSync(
    join(accountPaths.workspaceCatalog, 'catalog.json'),
    '{"version":1,"workspaces":[{"id":"workspace_repo"}]}\n',
  );
  const conversations = join(accountPaths.conversations, 'gateway');
  mkdirSync(join(conversations, 'records'), { recursive: true });
  writeFileSync(
    join(conversations, 'catalog.json'),
    '{"version":3,"conversations":[{"id":"conv_preserved"}]}\n',
  );
  writeFileSync(
    join(conversations, 'records', 'conv_preserved.json'),
    '{"version":3,"conversation":{"id":"conv_preserved"},"turns":[]}\n',
  );
}

function expectWorkspaceConversationState(
  accountPaths: ReturnType<typeof resolveAccountPaths>,
): void {
  expect(readFileSync(join(accountPaths.workspaceCatalog, 'catalog.json'), 'utf8'))
    .toContain('workspace_repo');
  expect(readFileSync(
    join(accountPaths.conversations, 'gateway', 'catalog.json'),
    'utf8',
  )).toContain('conv_preserved');
  expect(readFileSync(
    join(
      accountPaths.conversations,
      'gateway',
      'records',
      'conv_preserved.json',
    ),
    'utf8',
  )).toContain('"version":3');
}
