import {
  chmodSync,
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
  });

  it('drives a real clean install under ANYFUSION_INSTALL_ROOT', async () => {
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
        ANYFUSION_INSTALL_ROOT: installRoot,
        ANYFUSION_SECRET_STORE: 'file',
        ANYFUSION_PROVIDER_KEY: 'secret',
        ANYFUSION_PROVIDER_URL: 'https://provider.example/v1',
        ANYFUSION_PROVIDER_MODEL: 'model',
        ANYFUSION_PROVIDER_REGION: 'international',
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
      chmodSync(path, 0o700);
      for (const child of readdirSync(path)) makeWritable(join(path, child));
    } else if (!entry.isSymbolicLink()) {
      chmodSync(path, 0o600);
    }
  } catch {
    return;
  }
}
