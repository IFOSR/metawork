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
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { resolveAnyFusionPaths } from '../../src/installation/paths.js';
import { SourceNativeInstaller } from '../../src/installation/source-native-installer.js';
import { SourceNativeUpdater } from '../../src/installation/source-native-updater.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const root of cleanup.splice(0)) {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('SourceNativeUpdater', () => {
  it('backs up and clones the database, then activates one complete candidate set', async () => {
    const fixture = await installedFixture();
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
});

async function installedFixture() {
  const home = mkdtempSync(join(tmpdir(), 'anyfusion-source-update-'));
  cleanup.push(home);
  const sourceRoot = join(home, 'source-initial');
  const plannerRoot = join(home, 'planner-initial');
  fixtureRelease(sourceRoot, plannerRoot, 'runtime-initial\n', 'planner-initial\n');
  const paths = resolveAnyFusionPaths(home);
  const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root);
  const secretStore = new FileSecretStore(accountPaths.secrets);
  await new SourceNativeInstaller({
    paths,
    secretStore,
    detectCommand: async command => command === 'codex',
  }).install({
    releaseId: '1.2.0-preview.0',
    sourceRoot,
    plannerRoot,
    provider: {
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      modelId: 'model',
      region: 'international',
      secretReference: 'file-secret:anyfusion/provider',
    },
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
