// Consumes the formal Runtime/Planner archives; never assembles a second Server tree.
import { createHash, sign, verify } from 'node:crypto';
import { cp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopInventory, verifyDesktopRelease, validateDesktopArchivePath } from '../dist/release-tools.mjs';
import { desktopToolPaths, desktopProcessEnvironment } from '../dist/platform-tools.mjs';

const platform = process.platform;
if (!['darwin', 'win32'].includes(platform) || (platform === 'win32' && process.arch !== 'x64')) {
  throw new Error('Native macOS or Windows x64 builder required');
}

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw new Error('Use --name value arguments');
  args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const required = name => { if (!args.has(name)) throw new Error(`Missing --${name}`); return args.get(name); };
const artifacts = resolve(required('artifacts'));
const output = resolve(required('output'));
const nodeRoot = resolve(required('node-root'));
const gitRoot = resolve(required('git-root'));
const executorRoot = resolve(required('executor-root'));
const trustedKeys = JSON.parse(await readFile(required('trusted-keys'), 'utf8'));
const privateKey = await readFile(required('signing-key'), 'utf8');
const keyId = required('key-id');
const sourceCommit = required('source-commit');
const development = args.get('development') === 'true';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
function run(cmd, argv, cwd, env) {
  // Runtime/Planner inventories include full dependency trees and exceed Node's
  // default 1 MiB capture limit when tar lists their entries.
  const result = spawnSync(cmd, argv, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Dependency validation failed: ${basename(cmd)}`);
  return result.stdout.trim();
}
const manifest = JSON.parse(await readFile(join(artifacts, `manifest.${platform}-${process.arch}.json`), 'utf8'));
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};
const { signature: runtimeSignature, ...runtimePayload } = manifest;
if (!trustedKeys[runtimeSignature.keyId] || !verify(null, Buffer.from(canonical(runtimePayload)),
  trustedKeys[runtimeSignature.keyId], Buffer.from(runtimeSignature.value, 'base64'))) throw new Error('Runtime manifest signature rejected');
if (manifest.platform !== platform || manifest.arch !== process.arch || Date.parse(manifest.expiresAt) <= Date.now()
  || !sourceCommit.startsWith(manifest.metawork.revision) || manifest.planner.revision !== manifest.metawork.revision) throw new Error('Runtime compatibility matrix mismatch');
if (!development) {
  const source = fileURLToPath(new URL('../../../', import.meta.url));
  const dirty = run('git', ['status', '--porcelain'], source);
  if (dirty || run('git', ['rev-parse', 'HEAD'], source) !== sourceCommit) throw new Error('Production release requires the exact clean source commit');
  if (platform === 'darwin' && !args.get('codesign-identity')) throw new Error('Production payload requires a Developer ID signing identity');
}
if (platform === 'win32' && (!development || process.env.METAWORK_DESKTOP_INTERNAL !== '1')) {
  throw new Error('Windows currently requires the explicit internal candidate build policy');
}
// Output is an explicitly supplied build directory. Refuse to replace existing data.
await mkdir(output, { recursive: false });
const payload = join(output, 'payload');
await mkdir(payload);
async function removeArchiveMarkers(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await removeArchiveMarkers(path);
    else if (entry.name === '.gitkeep') await rm(path);
  }
}
try {
  const tar = platform === 'win32' ? join(process.env.SystemRoot, 'System32/tar.exe') : '/usr/bin/tar';
  for (const name of ['metawork', 'planner']) {
    const artifact = manifest[name];
    const archive = join(artifacts, basename(artifact.url));
    const bytes = await readFile(archive);
    if (bytes.length !== artifact.byteSize || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Formal release artifact hash mismatch');
    // Verify archive paths before extraction. Formal packager dereferences links.
    const entries = run(tar, ['-tf', archive]);
    for (const path of entries.split(/\r?\n/u)) validateDesktopArchivePath(path, platform);
    if (entries.split('\n').some(path => !path.startsWith(`${name}/`) || path.split('/').includes('..'))) throw new Error('Invalid release archive layout');
    const details = run(tar, ['-tvf', archive]);
    // `tar -h` dereferences source symlinks, but bsdtar may record repeated
    // inodes as hardlink entries (`h`). They extract as regular files; reject
    // symbolic links and all other special archive entries.
    if (details.split('\n').some(line => !['-', 'd', 'h'].includes(line[0]))) throw new Error('Release archive contains links or special files');
    run(tar, ['-xf', archive, '-C', payload]);
  }
  // Electron Builder omits dot-file placeholders while copying extraResources.
  await removeArchiveMarkers(payload);
  const toolRoot = join(payload, 'metawork', 'desktop-tools');
  for (const [name, root] of [['node', nodeRoot], ['git', gitRoot], ['executor', executorRoot]]) {
    await cp(root, join(toolRoot, name), { recursive: true, dereference: true });
    const inventory = await desktopInventory(join(toolRoot, name), platform);
    if (!Object.keys(inventory).some(path => /(?:^|\/)(?:licen[sc]e|copying|notice)[^/]*$/iu.test(path))) throw new Error(`Missing ${name} license notices`);
  }
  if (platform === 'win32') {
    // pip's distlib vendors launchers for every Windows architecture. Only the
    // x64 launchers can be selected by this pinned x64 Python runtime. Keep pip,
    // its sources/notices and x64 launchers; reject all other foreign binaries
    // through the complete inventory below.
    const distlib = join(payload, 'metawork/dist/pi-pdf/python/Lib/site-packages/pip/_vendor/distlib');
    for (const launcher of ['t32.exe', 'w32.exe', 't64-arm.exe', 'w64-arm.exe']) {
      await rm(join(distlib, launcher));
    }
    // The vendored Planner TUI is also present through npm's dereferenced
    // workspace path in the formal archive. Prune only its known foreign
    // prebuilds, in both copies, while preserving source and notices.
    for (const relative of ['planner/packages/tui', 'planner/node_modules/@earendil-works/pi-tui']) {
      const root = join(payload, relative);
      const tui = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      if (tui.name !== '@earendil-works/pi-tui' || tui.version !== '0.80.2') {
        throw new Error('Review vendored Planner TUI prebuild layout for the new version');
      }
      for (const path of ['native/darwin/prebuilds', 'native/win32/prebuilds/win32-arm64']) {
        await rm(join(root, path), { recursive: true });
      }
    }
    const native = join(payload, 'metawork/native/windows');
    await mkdir(native, { recursive: true });
    await cp(resolve(required('native-module')), join(native, 'metawork-platform.node'));
  }
  if (platform === 'darwin' && !development) {
    const magicValues = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
    for (const path of Object.keys(await desktopInventory(payload))) {
      const absolute = join(payload, path);
      const handle = await open(absolute, 'r');
      const magic = Buffer.alloc(4);
      try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
      if (!magicValues.has(magic.toString('hex'))) continue;
      // Sign every native module/library before the exact payload inventory is sealed.
      run('/usr/bin/codesign', ['--force', '--sign', required('codesign-identity'), '--options', 'runtime', '--timestamp',
        '--entitlements', fileURLToPath(new URL('./entitlements.mac.plist', import.meta.url)), absolute]);
      run('/usr/bin/codesign', ['--verify', '--strict', absolute]);
      const commands = run('/usr/bin/otool', ['-l', absolute]);
      // LC_ID_DYLIB is the library's own identity, not a linked dependency.
      // Source-built Intel cryptography can retain its build-time install name.
      for (const command of commands.split(/Load command \d+\n/u)) {
        if (!/^\s*cmd LC_(?:LOAD_(?:WEAK_|UPWARD_)?|REEXPORT_)DYLIB\s*$/mu.test(command)) continue;
        const library = /^\s*name (.+) \(offset \d+\)\s*$/mu.exec(command)?.[1];
        if (!library || (library.startsWith('/') && !library.startsWith('/usr/lib/')
          && !library.startsWith('/System/Library/'))) throw new Error('Runtime native dependency is not relocatable');
      }
    }
  }
  const tools = desktopToolPaths(join(payload, 'metawork'), platform);
  const node = tools.node;
  const toolEnv = desktopProcessEnvironment({ releaseRoot: join(payload, 'metawork'), nodePath: node, env: process.env });
  const facts = JSON.parse(run(node, ['-p', 'JSON.stringify({version:process.versions.node,abi:process.versions.modules,arch:process.arch,platform:process.platform})'], payload, toolEnv));
  if (facts.platform !== platform || facts.arch !== process.arch || facts.abi !== '127') throw new Error('Node platform/ABI mismatch');
  run(node, ['-e', "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.prepare('select 1').get(); db.close();"], join(payload, 'metawork'), toolEnv);
  run(tools.git, ['--version'], payload, toolEnv);
  if (platform === 'win32') {
    run(node, [tools.piScript, '--version'], payload, toolEnv);
    run(tools.bash, ['--noprofile', '--norc', '-c', 'exit 0'], payload, toolEnv);
    run(node, ['-e', 'const m=require(process.argv[1]); if(typeof m.pipeListen!=="function" || typeof m.writePrivateFile!=="function") throw Error("Native platform exports missing")',
      join(payload, 'metawork/native/windows/metawork-platform.node')], payload, toolEnv);
    run(node, [join(payload, 'planner/packages/coding-agent/dist/cli.js'), '--version'], payload, toolEnv);
  } else run(join(toolRoot, 'executor/bin/pi'), ['--version'], payload, toolEnv);
  const pdfRoot = join(payload, 'metawork/dist/pi-pdf');
  await readFile(join(pdfRoot, 'index.ts'));
  run(tools.python, ['-I', '-c',
    'import sys;sys.path.insert(0,sys.argv[1]);import pypdf,pdfplumber,pypdfium2,PIL',
    join(pdfRoot, 'site-packages')], payload, toolEnv);
  const release = {
    schemaVersion: 1, releaseId: manifest.releaseId, desktopVersion: pkg.version,
    electronVersion: pkg.devDependencies.electron, platform, arch: process.arch,
    sourceCommit, development, nodeVersion: facts.version, nodeAbi: facts.abi,
    gatewayProtocolVersion: 2, capabilities: ['desktop-session-v1'], runtimeManifest: manifest,
    files: await desktopInventory(payload, platform),
  };
  release.signature = { algorithm: 'ed25519', keyId, value: sign(null, Buffer.from(canonical(release)), privateKey).toString('base64') };
  await writeFile(join(output, 'desktop-release.json'), `${JSON.stringify(release, null, 2)}\n`);
  await writeFile(join(output, 'trusted-release-keys.json'), `${JSON.stringify(trustedKeys, null, 2)}\n`);
  await verifyDesktopRelease(output, { trustedKeys, platform: process.platform, arch: process.arch, desktopVersion: pkg.version, allowDevelopment: development });
  process.stdout.write(`Verified Desktop resources: ${output}\n`);
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
