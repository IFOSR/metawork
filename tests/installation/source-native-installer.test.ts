import Database from 'better-sqlite3';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { FileSecretStore } from '../../src/configuration/file-secret-store.js';
import { resolveAnyFusionPaths } from '../../src/installation/paths.js';
import { SourceNativeInstaller } from '../../src/installation/source-native-installer.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    makeWritable(path);
    rmSync(path, { recursive: true, force: true });
  }
});

describe('SourceNativeInstaller', () => {
  it('installs a complete release into a clean HOME and activates one coherent revision', async () => {
    const home = mkdtempSync(join(tmpdir(), 'anyfusion-source-install-'));
    cleanup.push(home);
    const sourceRoot = join(home, 'source');
    const plannerRoot = join(home, 'planner-source');
    fixtureRelease(sourceRoot, plannerRoot);
    const paths = resolveAnyFusionPaths(home);
    const secretStore = new FileSecretStore(paths.secrets);
    const installer = new SourceNativeInstaller({
      paths,
      secretStore,
      detectCommand: async command => command === 'codex',
    });

    const result = await installer.install({
      releaseId: '1.2.0-preview.0',
      sourceRoot,
      plannerRoot,
      provider: {
        baseUrl: 'https://provider.example/v1',
        apiKey: 'install-secret',
        modelId: 'gpt-test',
        region: 'international',
        secretReference: 'file-secret:anyfusion/provider',
      },
    });

    expect(result.releaseId).toBe('1.2.0-preview.0');
    expect(lstatSync(paths.appCurrent).isSymbolicLink()).toBe(true);
    expect(readlinkSync(paths.appCurrent)).toContain('releases/1.2.0-preview.0');
    expect(lstatSync(paths.database).isSymbolicLink()).toBe(true);
    expect(lstatSync(paths.generatedCurrent).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(paths.appCurrent, 'dist', 'index.js'), 'utf8')).toBe('runtime\n');
    expect(readFileSync(join(paths.appCurrent, 'planner', 'packages', 'coding-agent', 'dist', 'cli.js'), 'utf8'))
      .toBe('planner\n');
    await expect(secretStore.get('file-secret:anyfusion/provider')).resolves.toBe('install-secret');

    const repository = new FileConfigurationRepository(join(paths.root, 'config'));
    const snapshot = await repository.getActiveSnapshot();
    expect(snapshot.revisionId).toBe(result.configurationRevision);
    expect(snapshot.config.agentClasses['codex-engineering']?.enabled).toBe(true);
    expect(snapshot.config.agentClasses['pi-research']?.enabled).toBe(false);

    const db = new Database(paths.database, { readonly: true });
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 31 });
    db.close();
    expect(statSync(paths.database).mode & 0o777).toBe(0o600);
    expect(statSync(paths.launcher).mode & 0o777).toBe(0o755);
    const launcher = readFileSync(paths.launcher, 'utf8');
    expect(launcher).toContain('# AnyFusion managed launcher');
    expect(launcher).toContain('export ANYFUSION_PLANNER_WORKSPACE="$PWD"');
    expect(launcher).toContain('$ANYFUSION_INSTALL_ROOT/app/current/dist/index.js');
  });

  it('refuses to overwrite an unowned anyfusion launcher', async () => {
    const home = mkdtempSync(join(tmpdir(), 'anyfusion-source-install-collision-'));
    cleanup.push(home);
    const sourceRoot = join(home, 'source');
    const plannerRoot = join(home, 'planner-source');
    fixtureRelease(sourceRoot, plannerRoot);
    const paths = resolveAnyFusionPaths(home);
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(paths.launcher, '#!/bin/sh\necho other\n', { mode: 0o755 });

    await expect(new SourceNativeInstaller({
      paths,
      secretStore: new FileSecretStore(paths.secrets),
      detectCommand: async () => true,
    }).install({
      releaseId: '1.2.0-preview.0',
      sourceRoot,
      plannerRoot,
      provider: {
        baseUrl: 'https://provider.example/v1',
        apiKey: 'install-secret',
        modelId: 'gpt-test',
        region: 'international',
        secretReference: 'file-secret:anyfusion/provider',
      },
    })).rejects.toThrow(/launcher.*not managed by AnyFusion/i);

    expect(() => readFileSync(join(paths.releases, '1.2.0-preview.0', 'dist', 'index.js')))
      .toThrow();
  });

  it('removes immutable staged state when installation fails before activation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'anyfusion-source-install-cleanup-'));
    cleanup.push(home);
    const sourceRoot = join(home, 'source');
    const plannerRoot = join(home, 'planner-source');
    fixtureRelease(sourceRoot, plannerRoot);
    const paths = resolveAnyFusionPaths(home);
    const input = {
      releaseId: '1.2.0-preview.0',
      sourceRoot,
      plannerRoot,
      provider: {
        baseUrl: 'https://provider.example/v1',
        apiKey: 'install-secret',
        modelId: 'gpt-test',
        region: 'international',
        secretReference: 'file-secret:anyfusion/provider' as const,
      },
    };

    await expect(new SourceNativeInstaller({
      paths,
      secretStore: {
        get: async () => { throw new Error('missing'); },
        put: async () => { throw new Error('secret write failed'); },
        delete: async () => undefined,
      },
      detectCommand: async () => true,
    }).install(input)).rejects.toThrow('secret write failed');

    expect(() => statSync(join(paths.releases, input.releaseId))).toThrow();
    expect(() => statSync(paths.launcher)).toThrow();

    await expect(new SourceNativeInstaller({
      paths,
      secretStore: new FileSecretStore(paths.secrets),
      detectCommand: async () => true,
    }).install(input)).resolves.toMatchObject({ releaseId: input.releaseId });
  });
});

function fixtureRelease(sourceRoot: string, plannerRoot: string): void {
  mkdirSync(join(sourceRoot, 'dist'), { recursive: true });
  mkdirSync(join(sourceRoot, 'node_modules'), { recursive: true });
  writeFileSync(join(sourceRoot, 'dist', 'index.js'), 'runtime\n');
  writeFileSync(join(sourceRoot, 'package.json'), '{"name":"anyfusion"}\n');
  mkdirSync(join(plannerRoot, 'packages', 'coding-agent', 'dist'), { recursive: true });
  mkdirSync(join(plannerRoot, 'node_modules'), { recursive: true });
  writeFileSync(join(plannerRoot, 'packages', 'coding-agent', 'dist', 'cli.js'), 'planner\n');
  writeFileSync(join(plannerRoot, 'package.json'), '{"name":"anyfusion-pi"}\n');
}

function makeWritable(path: string): void {
  try {
    const entry = lstatSync(path);
    if (entry.isDirectory()) {
      for (const child of readdirSync(path)) {
        makeWritable(join(path, child));
      }
    }
    chmodSync(path, 0o700);
  } catch {
    return;
  }
}
