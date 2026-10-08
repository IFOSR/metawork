import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

export async function probePlatformFiles(addon, output, addonPath) {
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
    for (const maximum of [0, -1, 1.5, NaN, Infinity, 9 * 1024 * 1024 + 1, 2 ** 32 + 1]) {
      assert.throws(() => addon.writePrivateFile(root, 'invalid-limit', Buffer.from('x'), maximum));
      assert.throws(() => addon.readPrivateFile(root, 'nested\\endpoint.json', maximum));
    }
    const large = Buffer.alloc(128 * 1024, 42);
    addon.writePrivateFile(root, 'large', large, 9 * 1024 * 1024);
    assert.deepEqual(addon.readPrivateFile(root, 'large', 9 * 1024 * 1024), large);
    assert.throws(() => addon.readPrivateFile(root, 'large'), /bounded/);
    checks.push('explicit preference limits and invalid numeric limits');
    addon.writePrivateFile(root, 'locked', Buffer.from('retained while locked'));
    const lockScript = `$f=[IO.File]::Open('${join(root, 'locked').replaceAll("'", "''")}', 'Open', 'Read', 'Read');
      try { [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }`;
    const locker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(lockScript, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lockerExited = once(locker, 'exit');
    try {
      const [data] = await once(locker.stdout, 'data', { signal: AbortSignal.timeout(15000) });
      assert.match(data.toString(), /ready/);
      assert.throws(() => addon.writePrivateFile(root, 'locked', Buffer.from('replacement')), /replacement/);
      assert.equal(addon.readPrivateFile(root, 'locked').toString(), 'retained while locked');
      assert.equal((await readdir(root)).some((name) => name.startsWith('.metawork-write-')), false);
    } finally { locker.stdin.end('\n'); await lockerExited; }
    addon.writePrivateFile(root, 'locked', Buffer.from('replacement after unlock'));
    checks.push('locked destination preserves prior content, cleans temporary file and recovers');
    if (addonPath) {
      addon.writePrivateFile(root, 'concurrent', Buffer.alloc(16384, 0));
      const workerSource = `const {parentPort,workerData}=require('node:worker_threads');
        const assert=require('node:assert/strict'); const addon=require(workerData.addonPath);
        const deadline=Date.now()+15000; let completed=0;
        while(completed<100 && Date.now()<deadline) {
          try {
            if(workerData.writer) addon.writePrivateFile(workerData.root,'concurrent',Buffer.alloc(16384,workerData.writer));
            else { const value=addon.readPrivateFile(workerData.root,'concurrent');
              assert.equal(value.length,16384); assert(value.every(byte=>byte===value[0])); }
            completed++;
          } catch(error) { if(!/Win32=(32|33)$/.test(error.message)) throw error; }
        } assert.equal(completed,100); parentPort.postMessage(completed);`;
      const workers = [1, 2, 0, 0].map((writer) => new Worker(workerSource, { eval: true,
        workerData: { addonPath, root, writer } }));
      try {
        await Promise.all(workers.map(async (worker) => {
          const [code] = await once(worker, 'exit'); assert.equal(code, 0);
        }));
      } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
      assert.equal((await readdir(root)).some((name) => name.startsWith('.metawork-write-')), false);
      checks.push('two concurrent writers and two readers observe only whole private records');
    }
    addon.writePrivateFile(root, 'target', Buffer.from('retained'));
    addon.flushPrivateFile(join(root, 'target'));
    addon.flushPrivateDirectory(root);
    checks.push('writable private file and directory handles flush successfully');
    await link(join(root, 'target'), join(root, 'hard-link'));
    assert.throws(() => addon.writePrivateFile(root, 'hard-link', Buffer.from('denied')), /hard links/);
    await rm(join(root, 'hard-link'));
    await symlink(join(root, 'nested'), join(root, 'junction'), 'junction');
    assert.throws(() => addon.ensurePrivateDirectory(join(root, 'junction')), /directory/);
    assert.throws(() => addon.flushPrivateDirectory(join(root, 'junction')), /reparse/);
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
  if (!process.argv.includes('--reuse-build')) {
    execFileSync(process.execPath, [resolve('apps/desktop/node_modules/node-gyp/bin/node-gyp.js'),
      'rebuild', '--msvs_version=2022'], { cwd: native, stdio: 'inherit', timeout: 180_000 });
  }
  const addon = join(native, 'build/Release/metawork_platform.node');
  await probePlatformFiles(require(addon), join(evidence, 'node.json'), addon);
  const electronResult = join(evidence, 'electron.json');
  const entry = join(evidence, 'electron.cjs');
  await writeFile(entry, `const {app}=require('electron');
    app.setPath('userData', ${JSON.stringify(join(evidence, 'electron-home'))});
    app.whenReady().then(async()=>{
      const {probePlatformFiles}=await import(${JSON.stringify(import.meta.url)});
      await probePlatformFiles(require(${JSON.stringify(addon)}), ${JSON.stringify(electronResult)}, ${JSON.stringify(addon)});
      app.quit();
    }).catch(error=>{console.error(error);app.exit(1)});`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (['electron_run_as_node', 'node_options', 'node_path'].includes(key.toLowerCase())) delete env[key];
  execFileSync(require(resolve('apps/desktop/node_modules/electron')), [entry], { env, stdio: 'inherit', timeout: 60_000 });
  assert.equal(JSON.parse(await readFile(electronResult, 'utf8')).passed, true);
}
