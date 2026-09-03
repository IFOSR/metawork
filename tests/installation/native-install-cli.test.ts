import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../../src/account/account-id.js';
import { resolveAccountPaths } from '../../src/account/account-paths.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import {
  parseNativeInstallArgs,
  runNativeInstallCli,
} from '../../src/install-cli.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const root of cleanup.splice(0)) {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('native install CLI', () => {
  it('parses install, update, and rollback without accepting unknown flags', () => {
    expect(parseNativeInstallArgs([
      'install',
      '1.2.0-preview.0',
      '--source-root',
      '/source',
      '--planner-root',
      '/planner',
    ])).toMatchObject({
      command: 'install',
      releaseId: '1.2.0-preview.0',
      sourceRoot: '/source',
      plannerRoot: '/planner',
    });
    expect(parseNativeInstallArgs(['rollback', '1.1.0'])).toMatchObject({
      command: 'rollback',
      releaseId: '1.1.0',
    });
    expect(() => parseNativeInstallArgs(['install', '1.2.0', '--unknown']))
      .toThrow('unknown installer option');
    expect(() => parseNativeInstallArgs(['deploy', '1.2.0']))
      .toThrow('usage: metawork-install <install|update|rollback> <release-id>');
  });

  it('drives a real clean install under METAWORK_INSTALL_ROOT', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-native-cli-'));
    cleanup.push(root);
    const sourceRoot = join(root, 'source');
    const plannerRoot = join(root, 'planner-source');
    fixtureRelease(sourceRoot, plannerRoot);
    const installRoot = join(root, 'installed');
    const output: string[] = [];

    const exitCode = await runNativeInstallCli([
      'install',
      '1.2.0-preview.0',
      '--source-root',
      sourceRoot,
      '--planner-root',
      plannerRoot,
    ], {
      env: {
        HOME: root,
        METAWORK_INSTALL_ROOT: installRoot,
        METAWORK_SECRET_STORE: 'file',
        METAWORK_PROVIDER_KEY: 'secret',
        METAWORK_PROVIDER_URL: 'https://provider.example/v1',
        METAWORK_PROVIDER_MODEL: 'model',
        METAWORK_PROVIDER_REGION: 'international',
      },
      platform: 'linux',
      detectCommand: async command => command === 'codex',
      isServerRunning: async () => false,
      write: line => { output.push(line); },
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(join(installRoot, 'app', 'current', 'dist', 'index.js'), 'utf8'))
      .toBe('runtime\n');
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, installRoot);
    expect(lstatSync(accountPaths.database).isSymbolicLink()).toBe(true);
    expect(lstatSync(accountPaths.configActive).isSymbolicLink()).toBe(true);
    expect(lstatSync(accountPaths.generatedCurrent).isSymbolicLink()).toBe(true);
    expect(() => lstatSync(join(installRoot, 'data', 'metaclaw.db'))).toThrow();
    expect(() => lstatSync(join(installRoot, 'config', 'active'))).toThrow();
    expect(output.join('\n')).toContain('installed 1.2.0-preview.0');
    expect(output.join('\n')).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it('collects provider configuration through the wizard when env is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-native-cli-wizard-'));
    cleanup.push(root);
    const sourceRoot = join(root, 'source');
    const plannerRoot = join(root, 'planner-source');
    fixtureRelease(sourceRoot, plannerRoot);
    const installRoot = join(root, 'installed');

    const exitCode = await runNativeInstallCli([
      'install',
      '1.2.0-preview.0',
      '--source-root',
      sourceRoot,
      '--planner-root',
      plannerRoot,
    ], {
      env: {
        HOME: root,
        METAWORK_INSTALL_ROOT: installRoot,
        METAWORK_SECRET_STORE: 'file',
      },
      platform: 'linux',
      detectCommand: async () => true,
      isServerRunning: async () => false,
      isInteractive: () => true,
      collectProviderConfiguration: async defaults => {
        expect(defaults.baseUrl).toBeUndefined();
        expect(defaults.modelId).toBeUndefined();
        return {
          baseUrl: 'https://api.deepseek.com/v1',
          modelId: 'deepseek-chat',
          apiKey: 'wizard-secret',
        };
      },
    });

    expect(exitCode).toBe(0);
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, installRoot);
    const repository = new FileConfigurationRepository(accountPaths.config);
    await repository.initialize();
    const recovery = await repository.recover();
    expect(recovery.status).not.toBe('empty');
    const snapshot = await repository.getActiveSnapshot();
    expect(snapshot.config.providers.provider?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(snapshot.config.models['default-model']?.modelId).toBe('deepseek-chat');
  });

  it('fails closed without provider configuration in non-interactive installs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-native-cli-headless-'));
    cleanup.push(root);
    const sourceRoot = join(root, 'source');
    const plannerRoot = join(root, 'planner-source');
    fixtureRelease(sourceRoot, plannerRoot);
    const installRoot = join(root, 'installed');

    await expect(runNativeInstallCli([
      'install',
      '1.2.0-preview.0',
      '--source-root',
      sourceRoot,
      '--planner-root',
      plannerRoot,
    ], {
      env: {
        HOME: root,
        METAWORK_INSTALL_ROOT: installRoot,
        METAWORK_SECRET_STORE: 'file',
        METAWORK_PROVIDER_URL: 'https://provider.example/v1',
      },
      platform: 'linux',
      detectCommand: async () => true,
      isServerRunning: async () => false,
      isInteractive: () => false,
      collectProviderConfiguration: async () => {
        throw new Error('wizard must not run');
      },
    })).rejects.toThrow('provider configuration is required');

    expect(() => lstatSync(join(installRoot, 'app', 'releases', '1.2.0-preview.0')))
      .toThrow();
  });

  it('skips the wizard when provider environment variables are complete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-native-cli-env-'));
    cleanup.push(root);
    const sourceRoot = join(root, 'source');
    const plannerRoot = join(root, 'planner-source');
    fixtureRelease(sourceRoot, plannerRoot);
    const installRoot = join(root, 'installed');

    await expect(runNativeInstallCli([
      'install',
      '1.2.0-preview.0',
      '--source-root',
      sourceRoot,
      '--planner-root',
      plannerRoot,
    ], {
      env: {
        HOME: root,
        METAWORK_INSTALL_ROOT: installRoot,
        METAWORK_SECRET_STORE: 'file',
        METAWORK_PROVIDER_KEY: 'secret',
        METAWORK_PROVIDER_URL: 'https://provider.example/v1',
        METAWORK_PROVIDER_MODEL: 'model',
        METAWORK_PROVIDER_REGION: 'international',
      },
      platform: 'linux',
      detectCommand: async () => true,
      isServerRunning: async () => false,
      isInteractive: () => true,
      collectProviderConfiguration: async () => {
        throw new Error('wizard must not run');
      },
    })).resolves.toBe(0);
  });

  it('accepts the existing ANYFUSION variables as compatibility inputs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-native-cli-compat-'));
    cleanup.push(root);
    const sourceRoot = join(root, 'source');
    const plannerRoot = join(root, 'planner-source');
    fixtureRelease(sourceRoot, plannerRoot);
    const installRoot = join(root, 'installed');

    await expect(runNativeInstallCli([
      'install',
      '1.2.0-preview.0',
      '--source-root',
      sourceRoot,
      '--planner-root',
      plannerRoot,
    ], {
      env: {
        HOME: root,
        ANYFUSION_INSTALL_ROOT: installRoot,
        ANYFUSION_SECRET_STORE: 'file',
        ANYFUSION_PROVIDER_KEY: 'secret',
        ANYFUSION_PROVIDER_URL: 'https://provider.example/v1',
        ANYFUSION_PROVIDER_MODEL: 'model',
        ANYFUSION_PROVIDER_REGION: 'international',
      },
      platform: 'linux',
      detectCommand: async () => true,
      isServerRunning: async () => false,
    })).resolves.toBe(0);

    expect(readFileSync(join(installRoot, 'app', 'current', 'dist', 'index.js'), 'utf8'))
      .toBe('runtime\n');
  });

  it.each([
    ['METAWORK_INSTALL_ROOT', 'ANYFUSION_INSTALL_ROOT', '/meta', '/any'],
    ['METAWORK_SECRET_STORE', 'ANYFUSION_SECRET_STORE', 'file', 'keychain'],
    ['METAWORK_PROVIDER_KEY', 'ANYFUSION_PROVIDER_KEY', 'meta-secret', 'any-secret'],
    ['METAWORK_PROVIDER_URL', 'ANYFUSION_PROVIDER_URL', 'https://meta.example/v1', 'https://any.example/v1'],
    ['METAWORK_PROVIDER_MODEL', 'ANYFUSION_PROVIDER_MODEL', 'meta-model', 'any-model'],
    ['METAWORK_PROVIDER_REGION', 'ANYFUSION_PROVIDER_REGION', 'international', 'cn'],
  ])('fails closed when %s conflicts with %s', async (
    canonicalName,
    compatibilityName,
    canonicalValue,
    compatibilityValue,
  ) => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-native-cli-conflict-'));
    cleanup.push(root);
    const sourceRoot = join(root, 'source');
    const plannerRoot = join(root, 'planner-source');
    fixtureRelease(sourceRoot, plannerRoot);
    const installRoot = join(root, 'installed');
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      METAWORK_INSTALL_ROOT: installRoot,
      METAWORK_SECRET_STORE: 'file',
      METAWORK_PROVIDER_KEY: 'secret',
      METAWORK_PROVIDER_URL: 'https://provider.example/v1',
      METAWORK_PROVIDER_MODEL: 'model',
      METAWORK_PROVIDER_REGION: 'international',
      [canonicalName]: canonicalValue,
      [compatibilityName]: compatibilityValue,
    };

    await expect(runNativeInstallCli([
      'install',
      '1.2.0-preview.0',
      '--source-root',
      sourceRoot,
      '--planner-root',
      plannerRoot,
    ], {
      env,
      platform: 'linux',
      detectCommand: async () => true,
      isServerRunning: async () => false,
    })).rejects.toThrow(`${canonicalName} conflicts with compatibility variable ${compatibilityName}`);

    expect(() => lstatSync(join(installRoot, 'app', 'releases', '1.2.0-preview.0')))
      .toThrow();
  });

  it('refuses an offline update while the production runtime lock is live', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-native-cli-lock-'));
    cleanup.push(root);
    const installRoot = join(root, 'installed');
    const sourceRoot = join(root, 'source');
    const plannerRoot = join(root, 'planner-source');
    fixtureRelease(sourceRoot, plannerRoot);
    mkdirSync(join(installRoot, 'data'), { recursive: true });
    writeFileSync(
      join(installRoot, 'data', 'runtime.lock'),
      `{"pid":"${process.pid}","startedAt":"2026-08-19T00:00:00.000Z"}\n`,
    );

    await expect(runNativeInstallCli([
      'update',
      '1.2.0-preview.1',
      '--source-root',
      sourceRoot,
      '--planner-root',
      plannerRoot,
    ], {
      env: {
        HOME: root,
        ANYFUSION_INSTALL_ROOT: installRoot,
        ANYFUSION_SECRET_STORE: 'file',
      },
      platform: 'linux',
      detectCommand: async () => true,
    })).rejects.toThrow(
      'running Server cannot be safely coordinated by the offline installer',
    );
    expect(() => lstatSync(join(installRoot, 'app', 'releases', '1.2.0-preview.1')))
      .toThrow();
  });

  it('infers the existing file SecretStore during update without environment hints', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-native-cli-secret-store-'));
    cleanup.push(root);
    const installRoot = join(root, 'installed');
    const initialSource = join(root, 'source-initial');
    const initialPlanner = join(root, 'planner-initial');
    fixtureRelease(initialSource, initialPlanner, 'runtime-initial\n');
    await runNativeInstallCli([
      'install',
      '1.2.0-preview.0',
      '--source-root',
      initialSource,
      '--planner-root',
      initialPlanner,
    ], {
      env: {
        HOME: root,
        METAWORK_INSTALL_ROOT: installRoot,
        METAWORK_SECRET_STORE: 'file',
        METAWORK_PROVIDER_KEY: 'secret',
        METAWORK_PROVIDER_URL: 'https://provider.example/v1',
        METAWORK_PROVIDER_MODEL: 'model',
        METAWORK_PROVIDER_REGION: 'international',
      },
      platform: 'darwin',
      detectCommand: async () => true,
      isServerRunning: async () => false,
    });
    const nextSource = join(root, 'source-next');
    const nextPlanner = join(root, 'planner-next');
    fixtureRelease(nextSource, nextPlanner, 'runtime-next\n');

    await expect(runNativeInstallCli([
      'update',
      '1.2.0-preview.1',
      '--source-root',
      nextSource,
      '--planner-root',
      nextPlanner,
    ], {
      env: {
        HOME: root,
        METAWORK_INSTALL_ROOT: installRoot,
      },
      platform: 'darwin',
      detectCommand: async () => true,
      isServerRunning: async () => false,
    })).resolves.toBe(0);

    expect(readFileSync(join(installRoot, 'app', 'current', 'dist', 'index.js'), 'utf8'))
      .toBe('runtime-next\n');
  });

  it('migrates a default legacy AnyFusion root before a real update commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-native-cli-root-migration-'));
    cleanup.push(root);
    const initialSource = join(root, 'source-initial');
    const initialPlanner = join(root, 'planner-initial');
    fixtureRelease(initialSource, initialPlanner, 'runtime-initial\n');
    const legacyRoot = join(root, '.anyfusion');
    await runNativeInstallCli([
      'install',
      '1.2.0-preview.0',
      '--source-root',
      initialSource,
      '--planner-root',
      initialPlanner,
    ], {
      env: {
        HOME: root,
        ANYFUSION_INSTALL_ROOT: legacyRoot,
        ANYFUSION_SECRET_STORE: 'file',
        ANYFUSION_PROVIDER_KEY: 'secret',
        ANYFUSION_PROVIDER_URL: 'https://provider.example/v1',
        ANYFUSION_PROVIDER_MODEL: 'model',
        ANYFUSION_PROVIDER_REGION: 'international',
      },
      platform: 'linux',
      detectCommand: async () => true,
      isServerRunning: async () => false,
    });

    const nextSource = join(root, 'source-next');
    const nextPlanner = join(root, 'planner-next');
    fixtureRelease(nextSource, nextPlanner, 'runtime-next\n');

    await expect(runNativeInstallCli([
      'update',
      '1.2.1-preview.0',
      '--source-root',
      nextSource,
      '--planner-root',
      nextPlanner,
    ], {
      env: {
        HOME: root,
        METAWORK_SECRET_STORE: 'file',
      },
      platform: 'linux',
      detectCommand: async () => true,
      isServerRunning: async () => false,
    })).resolves.toBe(0);

    const canonicalRoot = join(root, '.metawork');
    expect(readFileSync(join(canonicalRoot, 'app', 'current', 'dist', 'index.js'), 'utf8'))
      .toBe('runtime-next\n');
    expect(existsSync(legacyRoot)).toBe(false);
    expect(readdirSync(root).some(name => name.startsWith('.anyfusion.migrated-')))
      .toBe(true);
    expect(readFileSync(join(root, '.local', 'bin', 'metawork'), 'utf8'))
      .toContain(`ANYFUSION_INSTALL_ROOT:-${canonicalRoot}`);
  });
});

function fixtureRelease(
  sourceRoot: string,
  plannerRoot: string,
  runtime = 'runtime\n',
): void {
  mkdirSync(join(sourceRoot, 'dist'), { recursive: true });
  mkdirSync(join(sourceRoot, 'node_modules'), { recursive: true });
  writeFileSync(join(sourceRoot, 'dist', 'index.js'), runtime);
  writeFileSync(join(sourceRoot, 'package.json'), '{"name":"anyfusion"}\n');
  mkdirSync(join(sourceRoot, 'web', 'dist'), { recursive: true });
  writeFileSync(join(sourceRoot, 'web', 'dist', 'index.html'), 'web\n');
  mkdirSync(join(plannerRoot, 'packages', 'coding-agent', 'dist'), { recursive: true });
  mkdirSync(join(plannerRoot, 'node_modules'), { recursive: true });
  writeFileSync(join(plannerRoot, 'packages', 'coding-agent', 'dist', 'cli.js'), 'planner\n');
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
