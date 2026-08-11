import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationMigrationService } from '../../src/configuration/configuration-migration-service.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { LegacyConfigurationReader } from '../../src/configuration/legacy-configuration-reader.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeImmutableTree));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anyfusion-legacy-migration-'));
  roots.push(root);
  await mkdir(join(root, 'planner'));
  await writeFile(join(root, 'config.yaml'), [
    'orchestration:',
    '  max_concurrent_attempts: 4',
    '',
  ].join('\n'));
  await writeFile(join(root, 'provider.env'), [
    'OPENAI_API_KEY="sk-legacy-secret"',
    'OPENAI_BASE_URL=https://api.example.com/v1/',
    '',
  ].join('\n'));
  await writeFile(join(root, 'planner-models.json'), JSON.stringify({
    providers: {
      legacy: {
        baseUrl: '__OPENAI_BASE_URL__',
        models: [{ id: 'legacy-model' }],
      },
    },
  }));
  return root;
}

describe('ConfigurationMigrationService', () => {
  it('creates a deterministic schema-v2 candidate and secret import plan', async () => {
    const root = await fixture();
    const reader = new LegacyConfigurationReader({ roots: [root], env: {} });
    const first = await new ConfigurationMigrationService(reader).dryRun();
    const second = await new ConfigurationMigrationService(reader).dryRun();

    expect(first.conflicts).toEqual([]);
    expect(first.candidateHash).toBe(second.candidateHash);
    expect(first.candidate.providers.openai).toMatchObject({
      baseUrl: 'https://api.example.com/v1',
      apiKeyRef: 'keychain:anyfusion/imported/openai',
    });
    expect(first.candidate.models['legacy-model']).toMatchObject({
      modelId: 'legacy-model',
    });
    expect(first.secretImportPlan).toEqual([{
      reference: 'keychain:anyfusion/imported/openai',
      sourcePath: join(root, 'provider.env'),
      sourceKey: 'OPENAI_API_KEY',
      valueSha256: expect.any(String),
    }]);
    expect(JSON.stringify(first)).not.toContain('sk-legacy-secret');
  });

  it('fails closed on conflicting Provider URLs and competing root overrides', async () => {
    const root = await fixture();
    await writeFile(join(root, 'second.env'), 'OPENAI_BASE_URL=https://other.example.com/v1\n');
    const reader = new LegacyConfigurationReader({
      roots: [root],
      env: {
        ANYFUSION_CONFIG_HOME: '/tmp/one',
        METACLAW_HOME: '/tmp/two',
      },
    });

    const report = await new ConfigurationMigrationService(reader).dryRun();

    expect(report.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'conflicting_provider_url', severity: 'error' }),
      expect.objectContaining({ code: 'conflicting_root_override', severity: 'error' }),
    ]));
    expect(report.staged).toBe(false);
  });

  it('reports dirty Planner repositories and stages no active pointer', async () => {
    const root = await fixture();
    const configRoot = join(root, 'new-config');
    const repository = new FileConfigurationRepository(configRoot);
    const reader = new LegacyConfigurationReader({
      roots: [root],
      env: {},
      inspectGit: async () => ({
        exists: true,
        dirty: true,
        head: 'abc123',
        statusHash: 'status-hash',
      }),
    });
    const service = new ConfigurationMigrationService(reader, repository);
    const report = await service.dryRun();

    expect(report.dirtyRepositories).toEqual([
      expect.objectContaining({ dirty: true }),
    ]);
    const staged = await service.stageCandidate(report);
    expect(staged.revisionId).toMatch(/^import-/u);
    await expect(repository.getActiveSnapshot()).rejects.toThrow(/active configuration/i);
    expect(await readFile(join(configRoot, 'revisions', staged.revisionId, 'config.yaml'), 'utf8'))
      .toContain('schemaVersion: 2');
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
    for (const child of await readdir(path)) await makeWritable(join(path, child));
  } else if (!info.isSymbolicLink()) {
    await chmod(path, 0o600);
  }
}
