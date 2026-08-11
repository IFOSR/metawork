import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dump } from 'js-yaml';
import {
  FileConfigurationRepository,
  RecoveryBlockedError,
} from '../../src/configuration/file-configuration-repository.js';
import { AnyFusionConfigurationV2Schema } from '../../src/configuration/schema.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeImmutableTree));
});

function config() {
  return AnyFusionConfigurationV2Schema.parse({
    schemaVersion: 2,
    providers: {},
    models: {},
    harnesses: {},
    agentClasses: {},
    permissionProfiles: {},
    runtimePolicy: {},
    gateway: {},
  });
}

describe('FileConfigurationRepository', () => {
  it('writes immutable revisions and switches one active symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-config-repository-'));
    roots.push(root);
    const repository = new FileConfigurationRepository(join(root, 'config'));
    await repository.initialize();

    await repository.writeRevision({
      revisionId: 'revision-1',
      contentHash: 'hash-1',
      files: {
        'config.yaml': dump(config(), { noRefs: true, sortKeys: true }),
        'planner.json': '{}\n',
      },
    });
    await repository.activateRevision('revision-1', null, 'activation-1');

    expect((await repository.getActiveSnapshot()).revisionId).toBe('revision-1');
    expect(await readFile(join(root, 'config', 'active', 'config.yaml'), 'utf8'))
      .toContain('schemaVersion: 2');
    expect((await stat(join(root, 'config', 'revisions', 'revision-1'))).mode & 0o777)
      .toBe(0o555);
    expect((await stat(join(root, 'config', 'revisions', 'revision-1', 'config.yaml'))).mode & 0o777)
      .toBe(0o444);
    await expect(repository.writeRevision({
      revisionId: 'revision-1',
      contentHash: 'hash-1',
      files: { 'config.yaml': 'schemaVersion: 2\n' },
    })).rejects.toThrow(/already exists/i);
  });

  it('recovers prepared activation without allowing mixed projections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-config-recovery-'));
    roots.push(root);
    const repository = new FileConfigurationRepository(join(root, 'config'));
    await repository.initialize();
    for (const revisionId of ['revision-1', 'revision-2']) {
      await repository.writeRevision({
        revisionId,
        contentHash: revisionId,
        files: { 'config.yaml': dump(config(), { noRefs: true, sortKeys: true }) },
      });
    }
    await repository.activateRevision('revision-1', null, 'activation-1');

    await repository.journal.writePrepared({
      transactionId: 'activation-2',
      previousRevisionId: 'revision-1',
      nextRevisionId: 'revision-2',
    });
    expect(await repository.recover()).toEqual({
      status: 'recovered',
      activeRevisionId: 'revision-1',
    });

    await repository.journal.writePrepared({
      transactionId: 'activation-3',
      previousRevisionId: 'revision-1',
      nextRevisionId: 'revision-2',
    });
    await repository.replaceActivePointer('revision-2');
    expect(await repository.recover()).toEqual({
      status: 'recovered',
      activeRevisionId: 'revision-2',
    });
    expect((await repository.journal.read())?.phase).toBe('committed');
  });

  it('enters recovery-blocked for missing or hash-mismatched active revisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-config-corrupt-'));
    roots.push(root);
    const repository = new FileConfigurationRepository(join(root, 'config'));
    await repository.initialize();
    await repository.writeRevision({
      revisionId: 'revision-1',
      contentHash: 'hash-1',
      files: { 'config.yaml': dump(config(), { noRefs: true, sortKeys: true }) },
    });
    await repository.activateRevision('revision-1', null, 'activation-1');

    const configPath = join(root, 'config', 'revisions', 'revision-1', 'config.yaml');
    await chmod(configPath, 0o644);
    await writeFile(configPath, 'schemaVersion: 999\n');
    await expect(repository.getActiveSnapshot()).rejects.toBeInstanceOf(RecoveryBlockedError);

    await unlink(join(root, 'config', 'active'));
    await repository.replaceActivePointer('missing-revision');
    await expect(repository.recover()).rejects.toBeInstanceOf(RecoveryBlockedError);
  });
});

async function removeImmutableTree(root: string): Promise<void> {
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const child of await readdir(path)) {
      await makeWritable(join(path, child));
    }
  } else if (!info.isSymbolicLink()) {
    await chmod(path, 0o600);
  }
}
