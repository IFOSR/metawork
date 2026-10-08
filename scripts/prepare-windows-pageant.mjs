// Build the locked ssh2 dependency's helper without changing its source or
// widening the Desktop binary allowlist. Run before signing Runtime archives.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native Windows x64 builder required');
if (!process.argv[2]) throw new Error('Usage: prepare-windows-pageant.mjs SSH2_PACKAGE_DIRECTORY');
const dependency = resolve(process.argv[2]);
const metadata = JSON.parse(await readFile(join(dependency, 'package.json'), 'utf8'));
const source = join(dependency, 'util/pagent.c');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceSha256 = hash(await readFile(source));
if (metadata.name !== 'ssh2' || metadata.version !== '1.17.0'
  || sourceSha256 !== '6a4825742849e5b1ee0b79e860746e8ceab511ef896d585ae4fc8e50567cfa46') {
  throw new Error('Review Pageant source and protocol before changing the pinned dependency');
}
const build = await mkdtemp(join(tmpdir(), 'metawork-pageant-'));
try {
  const config = fileURLToPath(new URL('../integrations/ssh2-pageant/', import.meta.url));
  const run = (command, args) => execFileSync(command, args, { stdio: 'inherit', windowsHide: true, timeout: 120_000 });
  run('cmake', ['-S', config, '-B', build, '-A', 'x64', `-DPAGEANT_SOURCE:FILEPATH=${source.replaceAll('\\', '/')}`]);
  run('cmake', ['--build', build, '--config', 'Release']);
  const executable = join(build, 'Release/pagent.exe');
  const bytes = await readFile(executable);
  const header = bytes.readUInt32LE(0x3c);
  if (bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.readUInt32LE(header) !== 0x4550
    || bytes.readUInt16LE(header + 4) !== 0x8664) throw new Error('Pageant helper is not PE x64');
  const noArgs = spawnSync(executable, [], { windowsHide: true, timeout: 5000 });
  if (noArgs.error || noArgs.status !== 10) throw new Error('Pageant helper argument rejection failed');
  run(join(build, 'Release/pageant-probe.exe'), [executable]);
  const unavailable = spawnSync(executable, ['5'], { windowsHide: true, timeout: 5000 });
  if (unavailable.error || unavailable.status !== 11) throw new Error('Pageant helper unavailable-agent rejection failed');
  await cp(executable, join(dependency, 'util/pagent.exe'));
  await writeFile(join(dependency, 'util/metawork-x64-build.json'), JSON.stringify({ package: 'ssh2', version: metadata.version,
    sourceSha256, binarySha256: hash(bytes), platform: 'win32', arch: 'x64', runtime: 'static-msvc',
    protocolFixture: 'ssh-agent-identities', argumentRejection: true, unavailableAgentRejection: true }, null, 2));
} finally {
  await rm(build, { recursive: true, force: true });
}
