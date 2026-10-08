import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function probePlatformFiles(addon, output) {
  const temporary = await mkdtemp(join(tmpdir(), 'mw-native-files-'));
  const root = join(temporary, '中文 private root');
  const checks = [];
  try {
    addon.ensurePrivateDirectory(root);
    addon.ensurePrivateDirectory(root);
    addon.ensurePrivateDirectory(join(root, 'nested'));
    addon.writePrivateFile(root, 'nested\\endpoint.json', Buffer.from('first'));
    assert.equal(addon.readPrivateFile(root, 'nested\\endpoint.json').toString(), 'first');
    checks.push('private initialization and Unicode nested file');
    for (let index = 0; index < 20; index++) {
      const bytes = Buffer.alloc(16384, index);
      addon.writePrivateFile(root, 'nested\\endpoint.json', bytes);
      assert.deepEqual(addon.readPrivateFile(root, 'nested\\endpoint.json'), bytes);
    }
    assert.deepEqual(await readdir(join(root, 'nested')), ['endpoint.json']);
    checks.push('atomic replacement keeps owner/ACL and no temporary files');
    assert.throws(() => addon.writePrivateFile(root, 'oversize', Buffer.alloc(65537)), /bounded/);
    for (const path of ['..\\outside', 'C:\\outside', 'nested\\..\\outside', 'file:stream']) {
      assert.throws(() => addon.writePrivateFile(root, path, Buffer.from('denied')));
    }
    checks.push('bounded content and path escape denial');
    addon.writePrivateFile(root, 'target', Buffer.from('retained'));
    await link(join(root, 'target'), join(root, 'hard-link'));
    assert.throws(() => addon.writePrivateFile(root, 'hard-link', Buffer.from('denied')), /hard links/);
    await rm(join(root, 'hard-link'));
    await symlink(join(root, 'nested'), join(root, 'junction'), 'junction');
    assert.throws(() => addon.ensurePrivateDirectory(join(root, 'junction')), /directory/);
    assert.throws(() => addon.writePrivateFile(root, 'junction\\endpoint.json', Buffer.from('denied')), /directory/);
    assert.equal(addon.readPrivateFile(root, 'target').toString(), 'retained');
    checks.push('hard-link and reparse replacement denied');
    const broad = join(temporary, 'broad'); await mkdir(broad);
    // Give all authenticated users read rights explicitly; do not rely on runner defaults.
    execFileSync('icacls.exe', [broad, '/grant', '*S-1-5-11:(OI)(CI)R'], { stdio: 'ignore', windowsHide: true });
    assert.throws(() => addon.ensurePrivateDirectory(broad), /ACL/);
    checks.push('existing broad directory is refused without rewriting its ACL');
    await writeFile(output, JSON.stringify({ passed: true, checks, host: process.versions,
      scope: 'platform-file-adapter', integration: 'desktop-preferences-only' }, null, 2));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native Windows x64 required');
  const require = createRequire(import.meta.url);
  const native = resolve('native/windows');
  const evidence = resolve('.tmp/windows-desktop-validation/platform-files');
  await mkdir(evidence, { recursive: true });
  execFileSync(process.execPath, [resolve('apps/desktop/node_modules/node-gyp/bin/node-gyp.js'),
    'rebuild', '--msvs_version=2022'], { cwd: native, stdio: 'inherit', timeout: 180_000 });
  const addon = join(native, 'build/Release/metawork_platform.node');
  await probePlatformFiles(require(addon), join(evidence, 'node.json'));
  const electronResult = join(evidence, 'electron.json');
  const entry = join(evidence, 'electron.cjs');
  await writeFile(entry, `const {app}=require('electron');
    app.setPath('userData', ${JSON.stringify(join(evidence, 'electron-home'))});
    app.whenReady().then(async()=>{
      const {probePlatformFiles}=await import(${JSON.stringify(import.meta.url)});
      await probePlatformFiles(require(${JSON.stringify(addon)}), ${JSON.stringify(electronResult)});
      app.quit();
    }).catch(error=>{console.error(error);app.exit(1)});`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (['electron_run_as_node', 'node_options', 'node_path'].includes(key.toLowerCase())) delete env[key];
  execFileSync(require(resolve('apps/desktop/node_modules/electron')), [entry], { env, stdio: 'inherit', timeout: 60_000 });
  assert.equal(JSON.parse(await readFile(electronResult, 'utf8')).passed, true);
}
