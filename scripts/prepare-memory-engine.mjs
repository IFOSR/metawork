#!/usr/bin/env node
// Prepares the pinned memory engine (TDAI MemoryCore) for packaging.
//
// The engine is an upstream MIT project with its own dependency tree, so it is
// fetched at build time instead of being vendored here. The revision comes from
// `memory/engine.lock.json`, and the packaging step records the lockfile hash
// and the archive hash in the signed release manifest.
//
// Usage:
//   node scripts/prepare-memory-engine.mjs [--target <dir>]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(repoRoot, 'memory', 'engine.lock.json'), 'utf8'));

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const target = resolve(argument('--target', join(repoRoot, 'memory', 'tdai')));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

if (!/^[0-9a-f]{7,40}$/u.test(lock.revision)) {
  throw new Error('memory/engine.lock.json must pin a commit');
}

if (!existsSync(join(target, '.git'))) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  run('git', ['init', '--quiet', target], repoRoot);
  run('git', ['-C', target, 'remote', 'add', 'origin', lock.source], repoRoot);
}
run('git', ['-C', target, 'fetch', '--depth', '1', 'origin', lock.revision], repoRoot);
run('git', ['-C', target, 'checkout', '--detach', 'FETCH_HEAD'], repoRoot);
const head = capture('git', ['-C', target, 'rev-parse', 'HEAD'], repoRoot);
if (!head.startsWith(lock.revision)) {
  throw new Error(`memory engine revision mismatch: expected ${lock.revision}, got ${head}`);
}

// The pinned upstream Gateway exposes its host-neutral routes, while
// MetaWork's adapter uses the v3 data-plane contract. Apply the small
// release-owned compatibility patch after every upstream checkout so a fresh
// CI build and a local rebuild produce the same packaged sidecar.
const compatibilityPatch = join(repoRoot, 'memory', 'tdai-metawork-compat.patch');
if (existsSync(compatibilityPatch)) {
  run('git', ['-C', target, 'apply', '--whitespace=nowarn', compatibilityPatch], repoRoot);
}

const packageJson = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
const lockfile = join(target, 'package-lock.json');
if (existsSync(lockfile)) {
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--legacy-peer-deps'], target);
} else {
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--legacy-peer-deps'], target);
}

if (typeof packageJson.scripts?.build === 'string') {
  run('npm', ['run', 'build'], target);
}

// The upstream plugin build does not publish its standalone Gateway entry.
// Compile the sidecar entry as a release-owned artifact while keeping package
// dependencies external so the extracted runtime can resolve them from its
// production node_modules tree.
const gatewayEntry = join(target, 'src', 'gateway', 'server.ts');
const gatewayOutput = join(target, 'dist', 'gateway', 'server.js');
if (!existsSync(gatewayEntry)) {
  throw new Error(`memory engine has no Gateway source at ${gatewayEntry}`);
}
const gatewayTypes = join(target, 'src', 'gateway', 'types.ts');
const gatewayServerSource = readFileSync(gatewayEntry, 'utf8');
if (!gatewayServerSource.includes('ftsAvailable: this.core.getVectorStore()?.isFtsAvailable() ?? false')) {
  const healthStoreMarker = '        vectorStore: !!this.core.getVectorStore(),';
  if (!gatewayServerSource.includes(healthStoreMarker)) {
    throw new Error('memory Gateway health response shape is incompatible with the MetaWork FTS5 gate');
  }
  const patchedServer = gatewayServerSource.replace(
    healthStoreMarker,
    `${healthStoreMarker}\n        ftsAvailable: this.core.getVectorStore()?.isFtsAvailable() ?? false,`,
  );
  await import('node:fs/promises').then(({ writeFile }) => writeFile(gatewayEntry, patchedServer));
  if (existsSync(gatewayTypes)) {
    const typesSource = readFileSync(gatewayTypes, 'utf8');
    const typeMarker = '    vectorStore: boolean;';
    if (typesSource.includes(typeMarker) && !typesSource.includes('    ftsAvailable: boolean;')) {
      await import('node:fs/promises').then(({ writeFile }) => writeFile(
        gatewayTypes,
        typesSource.replace(typeMarker, `${typeMarker}\n    ftsAvailable: boolean;`),
      ));
    }
  }
}
mkdirSync(dirname(gatewayOutput), { recursive: true });
run(process.execPath, [
  join(repoRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  gatewayEntry,
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--packages=external',
  `--outfile=${gatewayOutput}`,
], repoRoot);

if (!existsSync(join(target, lock.entry))) {
  throw new Error(
    `memory engine has no compiled gateway at ${lock.entry};`
    + ' the pinned revision must produce a build artifact so releases never run TypeScript at startup',
  );
}

process.stdout.write(`memory engine ready: ${target} @ ${head}\n`);
