// Consumes the formal Runtime/Planner archives; never assembles a second Server tree.
import { createHash, sign, verify } from 'node:crypto';
import { cp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopInventory, verifyDesktopRelease } from '../dist/release-tools.mjs';

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
const manifest = JSON.parse(await readFile(join(artifacts, `manifest.darwin-${process.arch}.json`), 'utf8'));
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};
const { signature: runtimeSignature, ...runtimePayload } = manifest;
if (!trustedKeys[runtimeSignature.keyId] || !verify(null, Buffer.from(canonical(runtimePayload)),
  trustedKeys[runtimeSignature.keyId], Buffer.from(runtimeSignature.value, 'base64'))) throw new Error('Runtime manifest signature rejected');
if (manifest.platform !== 'darwin' || manifest.arch !== process.arch || Date.parse(manifest.expiresAt) <= Date.now()
  || !sourceCommit.startsWith(manifest.metawork.revision) || manifest.planner.revision !== manifest.metawork.revision) throw new Error('Runtime compatibility matrix mismatch');
if (!development) {
  const source = fileURLToPath(new URL('../../../', import.meta.url));
  const dirty = run('git', ['status', '--porcelain'], source);
  if (dirty || run('git', ['rev-parse', 'HEAD'], source) !== sourceCommit) throw new Error('Production release requires the exact clean source commit');
  if (!args.get('codesign-identity')) throw new Error('Production payload requires a Developer ID signing identity');
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
  for (const name of ['metawork', 'planner']) {
    const artifact = manifest[name];
    const archive = join(artifacts, basename(artifact.url));
    const bytes = await readFile(archive);
    if (bytes.length !== artifact.byteSize || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Formal release artifact hash mismatch');
    // Verify archive paths before extraction. Formal packager dereferences links.
    const entries = run('/usr/bin/tar', ['-tzf', archive]);
    if (entries.split('\n').some(path => !path.startsWith(`${name}/`) || path.split('/').includes('..'))) throw new Error('Invalid release archive layout');
    const details = run('/usr/bin/tar', ['-tvzf', archive]);
    // `tar -h` dereferences source symlinks, but bsdtar may record repeated
    // inodes as hardlink entries (`h`). They extract as regular files; reject
    // symbolic links and all other special archive entries.
    if (details.split('\n').some(line => !['-', 'd', 'h'].includes(line[0]))) throw new Error('Release archive contains links or special files');
    run('/usr/bin/tar', ['-xzf', archive, '-C', payload]);
  }
  // Electron Builder omits dot-file placeholders while copying extraResources.
  await removeArchiveMarkers(payload);
  const toolRoot = join(payload, 'metawork', 'desktop-tools');
  for (const [name, root] of [['node', nodeRoot], ['git', gitRoot], ['executor', executorRoot]]) {
    await cp(root, join(toolRoot, name), { recursive: true, dereference: true });
    const inventory = await desktopInventory(join(toolRoot, name));
    if (!Object.keys(inventory).some(path => /(?:^|\/)(?:licen[sc]e|copying|notice)[^/]*$/iu.test(path))) throw new Error(`Missing ${name} license notices`);
  }
  if (!development) {
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
      const dependencies = run('/usr/bin/otool', ['-L', absolute]);
      if (dependencies.split('\n').slice(1).some(line => {
        const library = line.trim().split(' (')[0];
        return library.startsWith('/') && !library.startsWith('/usr/lib/') && !library.startsWith('/System/Library/');
      })) throw new Error('Runtime native dependency is not relocatable');
    }
  }
  const node = join(toolRoot, 'node/bin/node');
  const toolEnv = { ...process.env, PATH: [join(toolRoot, 'node/bin'), join(toolRoot, 'git/bin'), join(toolRoot, 'executor/bin'), '/usr/bin', '/bin'].join(':') };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete toolEnv[key];
  const facts = JSON.parse(run(node, ['-p', 'JSON.stringify({version:process.versions.node,abi:process.versions.modules,arch:process.arch,platform:process.platform})'], payload, toolEnv));
  if (facts.platform !== 'darwin' || facts.arch !== process.arch || facts.abi !== '127') throw new Error('Node platform/ABI mismatch');
  run(node, ['-e', "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.prepare('select 1').get(); db.close();"], join(payload, 'metawork'), toolEnv);
  run(join(toolRoot, 'git/bin/git'), ['--version'], payload, toolEnv);
  run(join(toolRoot, 'executor/bin/pi'), ['--version'], payload, toolEnv);
  const pdfRoot = join(payload, 'metawork/dist/pi-pdf');
  await readFile(join(pdfRoot, 'index.ts'));
  run(join(pdfRoot, 'python/bin/python3'), ['-I', '-c',
    'import sys;sys.path.insert(0,sys.argv[1]);import pypdf,pdfplumber,pypdfium2,PIL',
    join(pdfRoot, 'site-packages')], payload, toolEnv);
  const release = {
    schemaVersion: 1, releaseId: manifest.releaseId, desktopVersion: pkg.version,
    electronVersion: pkg.devDependencies.electron, platform: 'darwin', arch: process.arch,
    sourceCommit, development, nodeVersion: facts.version, nodeAbi: facts.abi,
    gatewayProtocolVersion: 2, capabilities: ['desktop-session-v1'], runtimeManifest: manifest,
    files: await desktopInventory(payload),
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
