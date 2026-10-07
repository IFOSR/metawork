// Same N-API binary in bundled Node and real Electron Main, without RunAsNode.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Native Windows x64 required');
const require = createRequire(import.meta.url);
const root = resolve('native/windows-probe');
const evidence = resolve('.tmp/windows-desktop-validation/node-api');
await mkdir(evidence, { recursive: true });
execFileSync(process.execPath, [resolve('apps/desktop/node_modules/node-gyp/bin/node-gyp.js'),
  'rebuild', '--msvs_version=2022'], { cwd: root, stdio: 'inherit', timeout: 180_000 });
const addon = join(root, 'build/Release/metawork_windows_probe.node');
assert.equal(require(addon).probe(), process.pid);
const electronEvidence = join(evidence, 'electron.json');
const entry = join(evidence, 'electron-probe.cjs');
await writeFile(entry, `
const { app } = require('electron');
const { writeFileSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(evidence, 'electron-user-data'))});
app.whenReady().then(() => {
  const pid = require(${JSON.stringify(addon)}).probe();
  if (pid !== process.pid || process.type !== 'browser') throw Error('Native module host mismatch');
  writeFileSync(${JSON.stringify(electronEvidence)}, JSON.stringify({
    passed: true, pid, electron: process.versions.electron, node: process.versions.node,
    napi: process.versions.napi, processType: process.type
  }, null, 2));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
`);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (['electron_run_as_node', 'node_options', 'node_path'].includes(key.toLowerCase())) delete env[key];
}
execFileSync(require(resolve('apps/desktop/node_modules/electron')), [entry], {
  env, timeout: 30_000, stdio: 'inherit',
});
const electron = JSON.parse(await readFile(electronEvidence, 'utf8'));
assert.equal(electron.passed, true);
await writeFile(join(evidence, 'result.json'), JSON.stringify({
  scope: 'native-carrier-probe', node: process.version, nodePid: process.pid, electron,
  passed: true, sameBinary: true, p0Accepted: false,
  remaining: ['asynchronous transport and cleanup', 'production integration', 'packaged distribution'],
}, null, 2));
