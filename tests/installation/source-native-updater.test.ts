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
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    const previousDatabaseTarget = readlinkSync(fixture.paths.database);
    const previousConfigurationTarget = readlinkSync(join(fixture.paths.root, 'config', 'active'));
    const previousGeneratedTarget = readlinkSync(fixture.paths.generatedCurrent);
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
    expect(readlinkSync(fixture.paths.database)).not.toBe(previousDatabaseTarget);
    expect(readlinkSync(join(fixture.paths.root, 'config', 'active')))
      .toBe(previousConfigurationTarget);
    expect(readlinkSync(fixture.paths.generatedCurrent)).toBe(previousGeneratedTarget);
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8')) as {
      phase: string;
    };
    expect(journal.phase).toBe('committed');
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

  it('rolls back to the exact previously journaled compatible pointer set', async () => {
    const fixture = await installedFixture();
    const initialTargets = {
      database: readlinkSync(fixture.paths.database),
      configuration: readlinkSync(join(fixture.paths.root, 'config', 'active')),
      generated: readlinkSync(fixture.paths.generatedCurrent),
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
    expect(readlinkSync(fixture.paths.database)).toBe(initialTargets.database);
    expect(readlinkSync(fixture.paths.appCurrent)).toBe(initialTargets.application);
    expect(readlinkSync(join(fixture.paths.root, 'config', 'active')))
      .not.toBe(initialTargets.configuration);
    expect(readlinkSync(fixture.paths.generatedCurrent)).not.toBe(initialTargets.generated);
    expect(readFileSync(join(fixture.paths.appCurrent, 'dist', 'index.js'), 'utf8'))
      .toBe('runtime-initial\n');
    const repository = new FileConfigurationRepository(join(fixture.paths.root, 'config'));
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
      database: readlinkSync(fixture.paths.database),
      configuration: readlinkSync(join(fixture.paths.root, 'config', 'active')),
      generated: readlinkSync(fixture.paths.generatedCurrent),
      application: readlinkSync(fixture.paths.appCurrent),
    };
    const interruptedDatabase = join(fixture.paths.databaseRevisions, 'interrupted.db');
    writeFileSync(interruptedDatabase, 'not-a-database');
    rmSync(fixture.paths.database);
    symlinkSync(
      join('database-revisions', 'interrupted.db'),
      fixture.paths.database,
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
        database: fixture.paths.database,
        configuration: join(fixture.paths.root, 'config', 'active'),
        generated: fixture.paths.generatedCurrent,
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
  const secretStore = new FileSecretStore(paths.secrets);
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
  return { home, paths, secretStore };
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
