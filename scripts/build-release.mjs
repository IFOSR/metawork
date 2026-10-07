#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { architectureName, platformName } from './package-release.mjs';

function parseArguments(argv) {
  const options = {
    platform: platformName(),
    arch: architectureName(),
    outDir: undefined,
    channel: 'stable',
    releaseId: undefined,
    signingKey: undefined,
    artifactBaseUrl: undefined,
    packageOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    const requireValue = () => {
      if (!next || next.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    switch (argument) {
      case '--platform': options.platform = requireValue(); break;
      case '--arch': options.arch = requireValue(); break;
      case '--out-dir': options.outDir = resolve(requireValue()); break;
      case '--channel': options.channel = requireValue(); break;
      case '--release-id': options.releaseId = requireValue(); break;
      case '--signing-key': options.signingKey = resolve(requireValue()); break;
      case '--artifact-base-url': options.artifactBaseUrl = requireValue(); break;
      case '--package-only': options.packageOnly = true; break;
      default: throw new Error(`unknown option: ${argument}`);
    }
  }
  return options;
}

function run(command, args, cwd = process.cwd()) {
  const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
  const result = spawnSync(executable, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && executable.endsWith('.cmd'),
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`
      + (result.error ? `: ${result.error.message}` : ''),
    );
  }
}

function assertBetterSqlite3Runtime(sourceRoot) {
  const nativeBinary = resolve(
    sourceRoot,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  if (!existsSync(nativeBinary)) {
    throw new Error(
      `missing better-sqlite3 native binary: ${nativeBinary}; `
      + 'production dependencies must be installed without --ignore-scripts',
    );
  }
  run(process.execPath, [
    '-e',
    [
      "const Database = require('better-sqlite3');",
      "const db = new Database(':memory:');",
      "db.prepare('select 1 as ok').get();",
      'db.close();',
    ].join(' '),
  ], sourceRoot);
}

function assertNativeTarget(options) {
  const hostPlatform = platformName();
  const hostArch = architectureName();
  if (!options.packageOnly && (
    options.platform !== hostPlatform
    || options.arch !== hostArch
  )) {
    throw new Error(
      `target platform must match the build host: host=${hostPlatform}-${hostArch}, `
      + `target=${options.platform}-${options.arch}; use a native runner or --package-only `
      + 'with prebuilt target dependencies',
    );
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  assertNativeTarget(options);
  const plannerRoot = resolve('planner', 'AnyFusion-Pi');
  const packageArgs = [
    'scripts/package-release.mjs',
    '--platform',
    options.platform,
    '--arch',
    options.arch,
    ...(options.outDir ? ['--out-dir', options.outDir] : []),
    '--channel',
    options.channel,
    ...(options.releaseId ? ['--release-id', options.releaseId] : []),
    ...(options.signingKey ? ['--signing-key', options.signingKey] : []),
    ...(options.artifactBaseUrl ? ['--artifact-base-url', options.artifactBaseUrl] : []),
  ];

  if (!options.packageOnly) {
    run('npm', ['ci']);
    run('npm', ['run', 'build']);
    run('npm', ['ci', '--ignore-scripts'], plannerRoot);
    run('npm', ['run', 'build:offline'], plannerRoot);
    run('npm', ['ci', '--omit=dev']);
    run('npm', ['ci', '--omit=dev'], plannerRoot);
    assertBetterSqlite3Runtime(process.cwd());
  }
  run(process.execPath, packageArgs);
}

try {
  main();
} catch (error) {
  process.stderr.write(`build-release failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
