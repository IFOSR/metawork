#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPiRuntimePin } from './lib/pi-runtime-pin.mjs';

// Clean CI has no operator-managed Pi. Install the reviewed upstream version in
// a separate build host, using npm's locked integrity checks. Product runtimes
// subsequently receive a copy; neither global packages nor user data are used.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(repository, '.tmp/pi-build-host'));
const staging = `${output}.stage-${randomUUID()}`;
try {
  const existing = await lstat(output).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) throw new Error(`Pi build host destination already exists: ${output}`);
  const input = join(repository, 'tools/pi-runtime');
  const manifest = JSON.parse(await readFile(join(input, 'package.json'), 'utf8'));
  const version = manifest.dependencies['@earendil-works/pi-coding-agent'];
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('Pi build host requires an exact upstream version');
  const release = join(staging, 'install/releases', version);
  await mkdir(release, { recursive: true });
  await Promise.all(['package.json', 'package-lock.json'].map(file => copyFile(join(input, file), join(release, file))));
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: release, stdio: 'inherit' });
  const pkg = JSON.parse(await readFile(join(release, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'));
  const entry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
  if (pkg.version !== version || typeof entry !== 'string' || !/^[A-Za-z0-9_./-]+$/u.test(entry)
    || entry.startsWith('/') || entry.split('/').includes('..')) throw new Error('Invalid upstream Pi build input');
  await mkdir(join(staging, 'bin'));
  await writeFile(join(staging, 'bin/pi'), `#!/bin/sh
set -eu
agent_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node "$agent_root/install/releases/${version}/node_modules/@earendil-works/pi-coding-agent/${entry}" "$@"
`, { mode: 0o755 });
  assertPiRuntimePin({ command: join(staging, 'bin/pi') });
  await mkdir(dirname(output), { recursive: true });
  // Refuse to replace an existing host. In particular, callers must not point
  // this preparation command at their actual Pi installation.
  await rename(staging, output);
  process.stdout.write(`Pi build host ready: ${join(output, 'bin/pi')}\n`);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}
