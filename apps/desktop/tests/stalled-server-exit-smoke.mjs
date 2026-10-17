import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Real launchd/OS regression: a disposable legacy Server withdraws its runtime
// facts, then stops executing before OS exit. Never touches a user's install.
const fixture = resolve(process.argv[2]);
const { DesktopServiceManager, startMacOSBackgroundProcess, macOSBackgroundTarget } =
  await import(pathToFileURL(join(fixture, 'fixture-tools.mjs')).href);
const root = await realpath(await mkdtemp('/tmp/metawork-exit-'));
const release = join(root, 'app/releases/legacy');
const node = join(release, 'desktop-tools/node/bin/node');
await mkdir(join(release, 'dist'), { recursive: true });
await mkdir(join(release, 'desktop-tools/node/bin'), { recursive: true });
await mkdir(join(root, 'data'));
await cp(process.execPath, node);
await writeFile(join(release, 'release-identity.json'), JSON.stringify({ version: 1, releaseId: 'legacy', gatewayProtocolVersion: 2 }));
await symlink('releases/legacy', join(root, 'app/current'));
await writeFile(join(release, 'dist/index.js'), `
const fs = require('node:fs');
const root = process.env.METAWORK_INSTALL_ROOT;
const lock = root + '/data/runtime.lock';
const endpoint = root + '/server-endpoint.json';
if (process.argv[3] === 'stop') {
  if (fs.existsSync(lock)) process.kill(Number(JSON.parse(fs.readFileSync(lock)).pid), 'SIGTERM');
  setTimeout(() => process.exit(1), 100);
} else {
  fs.writeFileSync(lock, JSON.stringify({pid:process.pid}));
  fs.writeFileSync(endpoint, '{}');
  process.on('SIGTERM', () => {
    fs.unlinkSync(endpoint); fs.unlinkSync(lock);
    process.kill(process.pid, 'SIGSTOP');
  });
  setInterval(() => {}, 1000);
}
`);
const env = { PATH: '/usr/bin:/bin', METAWORK_INSTALL_ROOT: root };
const manager = new DesktopServiceManager({ installRoot: root, releaseId: 'legacy', nodePath: node, env });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(100); }
  throw new Error('Fixture did not reach expected state');
}
const exists = path => readFile(path).then(() => true, () => false);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const evidence = [];
let pid;
try {
  for (const phase of ['upgrade-stop', 'interrupted-repair-without-lock']) {
    await startMacOSBackgroundProcess({ root, role: 'server', executable: node,
      args: [join(release, 'dist/index.js'), 'server', 'start'], cwd: root, env, logPath: join(root, 'server.log') });
    await until(() => exists(join(root, 'data/runtime.lock')));
    pid = Number(JSON.parse(await readFile(join(root, 'data/runtime.lock'), 'utf8')).pid);
    if (phase === 'interrupted-repair-without-lock') {
      process.kill(pid, 'SIGTERM');
      await until(async () => !await exists(join(root, 'data/runtime.lock')));
      assert(alive(pid), 'The stopped legacy process must survive loss of runtime facts');
    }
    const start = Date.now();
    await manager.stopForUpdate();
    assert(!alive(pid));
    assert(!await exists(join(root, 'data/runtime.lock')));
    evidence.push({ phase, exited: true, elapsedMs: Date.now() - start });
    console.log(`PASS: ${phase}; actual launchd process exited`);
    pid = undefined;
  }
  await writeFile(join(fixture, 'stalled-server-evidence.json'), JSON.stringify({ root, evidence }, null, 2));
} finally {
  if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
  try { execFileSync('/bin/launchctl', ['bootout', await macOSBackgroundTarget(root, 'server')], { stdio: 'pipe' }); } catch {}
}
