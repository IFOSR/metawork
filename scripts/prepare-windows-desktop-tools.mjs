import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopInventory } from '../apps/desktop/dist/release-tools.mjs';
import { desktopProcessEnvironment } from '../apps/desktop/dist/platform-tools.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 native builder required');
if (!process.argv[2]) throw new Error('Usage: prepare-windows-desktop-tools.mjs NEW_OUTPUT_DIRECTORY');
const output = resolve(process.argv[2]);
const configuration = fileURLToPath(new URL('../integrations/windows-desktop-tools/', import.meta.url));
const manifest = JSON.parse(await readFile(join(configuration, 'manifest.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(configuration, manifest.pi.lockfile), 'utf8'));
const piPackage = lock.packages[`node_modules/${manifest.pi.package}`];
if (piPackage.version !== manifest.pi.version || piPackage.integrity !== manifest.pi.integrity) throw new Error('Pi lock disagrees with tool manifest');
const sevenZip = process.env.METAWORK_BUILD_7ZIP || 'C:\\Program Files\\7-Zip\\7z.exe';
const curl = join(process.env.SystemRoot, 'System32/curl.exe');
function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...options }).trim();
}
await mkdir(output, { recursive: false });
const downloads = join(output, '_downloads');
try {
  await mkdir(downloads);
  for (const name of ['node', 'git']) {
    const artifact = manifest[name];
    const archive = join(downloads, basename(new URL(artifact.url).pathname));
    run(curl, ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--retry', '2',
      '--connect-timeout', '20', '--max-time', '600', '--output', archive, artifact.url]);
    if (createHash('sha256').update(await readFile(archive)).digest('hex') !== artifact.sha256) throw new Error(`${name} archive hash mismatch`);
    const listing = run(sevenZip, ['l', '-slt', '-ba', archive]);
    for (const line of listing.split(/\r?\n/u)) {
      if (/^(?:Symbolic Link|Hard Link) =/u.test(line)) throw new Error('Tool archive contains links');
      if (!line.startsWith('Path = ')) continue;
      const path = line.slice(7);
      if (win32.isAbsolute(path) || path.includes(':') || path.split(/[\\/]/u).includes('..')) throw new Error('Tool archive escapes output');
    }
    const destination = name === 'node' ? downloads : join(output, name);
    run(sevenZip, ['x', '-y', `-o${destination}`, archive]);
    if (name === 'node') await rename(join(downloads, `node-v${artifact.version}-win-x64`), join(output, 'node'));
  }
  const executor = join(output, 'executor');
  await mkdir(executor);
  for (const file of ['package.json', 'package-lock.json']) await cp(join(configuration, 'executor', file), join(executor, file));
  const node = join(output, 'node/node.exe');
  const toolEnv = desktopProcessEnvironment({ releaseRoot: resolve(output, '..'), nodePath: node, env: process.env });
  // Explicit PATH also works when the caller names the output something other than desktop-tools.
  toolEnv.PATH = [join(output, 'node'), join(output, 'git/cmd'), join(output, 'executor/node_modules/.bin'),
    join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';');
  const npm = join(output, 'node/node_modules/npm/bin/npm-cli.js');
  run(node, [npm, 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: executor, env: toolEnv });
  // Pi TUI's locked package ships all six OS/architecture prebuilds in one
  // tarball. Its native loader selects native/<platform>/prebuilds/<platform>-<arch>.
  // Keep the Windows x64 helper and notices; do not ship foreign native code.
  const tui = join(executor, 'node_modules/@earendil-works/pi-tui');
  const tuiPackage = JSON.parse(await readFile(join(tui, 'package.json'), 'utf8'));
  if (tuiPackage.version !== '1.1.0') throw new Error('Review Pi TUI native pruning for the new locked version');
  const omittedPrebuilds = ['native/darwin/prebuilds', 'native/linux/prebuilds', 'native/win32/prebuilds/win32-arm64'];
  for (const path of omittedPrebuilds) await rm(join(tui, path), { recursive: true });
  run(node, ['-e', 'const helper=require(process.argv[1]); if(typeof helper.getText!=="function" || typeof helper.getImage!=="function") throw Error("Pi TUI native helper mismatch")',
    join(tui, 'native/win32/prebuilds/win32-x64/win32-platform.node')], { env: toolEnv });
  await rm(downloads, { recursive: true });
  const nodeFacts = JSON.parse(run(node, ['-p', 'JSON.stringify({version:process.versions.node,abi:process.versions.modules,arch:process.arch,platform:process.platform})'], { env: toolEnv }));
  if (nodeFacts.version !== manifest.node.version || nodeFacts.abi !== '127' || nodeFacts.arch !== 'x64' || nodeFacts.platform !== 'win32') throw new Error('Bundled Node matrix mismatch');
  const gitVersion = run(join(output, 'git/cmd/git.exe'), ['--version'], { env: toolEnv });
  if (gitVersion !== `git version ${manifest.git.version}`) throw new Error('Bundled Git version mismatch');
  const credentialManagerVersion = run(join(output, 'git/cmd/git.exe'), ['credential-manager', '--version'], { env: toolEnv });
  if (!credentialManagerVersion) throw new Error('Bundled managed Git Credential Manager did not load');
  // MSYS uses the 32-bit helper for WOW64 process compatibility. The one-arg
  // form only resolves a local exported function; no target PID or injection.
  const wow64 = run(join(output, 'git/usr/libexec/getprocaddr32.exe'), ['ExitProcess'], { env: toolEnv });
  if (!/^(?:0x)?[a-f0-9]+$/iu.test(wow64) || /^0+(?:x0+)?$/iu.test(wow64)) throw new Error('Git WOW64 helper did not load');
  const shellOutput = run(join(output, 'git/bin/bash.exe'), ['--noprofile', '--norc', '-c', 'printf metawork-bash-ok'], { env: toolEnv });
  if (shellOutput !== 'metawork-bash-ok') throw new Error('Bundled Bash failed');
  const piVersion = run(node, [join(executor, `node_modules/${manifest.pi.package}/dist/cli.js`), '--version'], { env: { ...toolEnv, PI_SKIP_VERSION_CHECK: '1' } });
  if (piVersion !== manifest.pi.version) throw new Error('Bundled Pi version mismatch');
  const files = await desktopInventory(output, 'win32');
  for (const [path, file] of Object.entries(files)) {
    if (file.format === 'pe-x86' && path !== 'git/usr/libexec/getprocaddr32.exe') throw new Error(`Unapproved x86 tool: ${path}`);
  }
  for (const tool of ['node', 'git', 'executor']) {
    if (!Object.keys(files).some(path => path.startsWith(`${tool}/`) && /(?:^|\/)(?:licen[sc]e|copying|notice)[^/]*$/iu.test(path))) throw new Error(`Missing ${tool} licenses`);
  }
  await writeFile(join(output, 'tools-provenance.json'), JSON.stringify({ manifest, nodeFacts, gitVersion, piVersion, credentialManagerVersion,
    bash: shellOutput, gitWow64HelperVerified: true, omittedPiTuiPrebuilds: omittedPrebuilds, fileCount: Object.keys(files).length,
    inventorySha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') }, null, 2));
  process.stdout.write(`Verified Windows Desktop tools: ${output}\n`);
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
