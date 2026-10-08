import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import Database from 'better-sqlite3';

// Uses LaunchServices (the Finder path), never Playwright's direct Electron spawn.
// Usage: <fixture directory> </tmp/metawork-...> <actual previous Runtime>
const fixture = resolve(process.argv[2]);
const root = resolve(process.argv[3]);
const previousRuntime = resolve(process.argv[4]);
if (!root.startsWith('/tmp/metawork-')) throw new Error('A disposable short fixture root is required');
const app = join(fixture, 'MetaWork.app');
const resources = join(app, 'Contents/Resources');
const descriptor = JSON.parse(await readFile(join(resources, 'desktop-release.json'), 'utf8'));
const previous = JSON.parse(await readFile(join(previousRuntime, 'release-identity.json'), 'utf8'));
const { SourceNativeInstaller, resolveMetaWorkPaths, createProductionSecretStore, DesktopServiceManager, commandExistsOnPath } =
  await import(pathToFileURL(join(fixture, 'fixture-tools.mjs')).href);
const node = join(resources, 'payload/metawork/desktop-tools/node/bin/node');
const toolsPath = ['node', 'git', 'executor'].map(name => join(resources, 'payload/metawork/desktop-tools', name, 'bin')).join(':');
const env = { PATH: `${toolsPath}:/usr/bin:/bin`, METAWORK_INSTALL_ROOT: root, ANYFUSION_INSTALL_ROOT: root,
  METAWORK_CONFIG_HOME: join(root, 'config'), ANYFUSION_CONFIG_HOME: join(root, 'config'),
  METAWORK_WEB_PORT: '0', METAWORK_SECRET_STORE: 'file', ANYFUSION_SECRET_STORE: 'file',
  METAWORK_INTERNAL_LLM_SOURCE_ROOT: join(root, 'absent-internal-config') };
Object.assign(process.env, env);
const paths = resolveMetaWorkPaths(undefined, root);
await new SourceNativeInstaller({ paths, secretStore: createProductionSecretStore({ credentialsFile: paths.credentials }),
  detectCommand: name => commandExistsOnPath(name, env.PATH), installLaunchers: false }).install({
  releaseId: previous.releaseId, sourceRoot: previousRuntime, plannerRoot: join(previousRuntime, 'planner'),
  executorPreset: 'desktop-pi', provider: { baseUrl: 'https://provider.example.invalid/v1', modelId: 'deepseek-chat',
    apiKey: 'existing-user-fixture', region: 'international', secretReference: 'file-secret:anyfusion/providers/provider' },
});
const dbPath = join(root, 'accounts/local-default/data/anyfusion.db');
const db = new Database(dbPath);
db.exec("CREATE TABLE desktop_finder_acceptance (value TEXT); INSERT INTO desktop_finder_acceptance VALUES ('preserved work');"); db.close();
const configPath = join(root, 'accounts/local-default/config/active/revision-manifest.json');
const configHash = JSON.parse(await readFile(configPath, 'utf8')).contentHash;
await mkdir(join(root, 'upgrades'), { recursive: true });
// A real repeat installation has a completed old transaction plus a dead helper
// and an interrupted pre-verification status. These facts must not cause a loop.
await writeFile(join(root, 'upgrades/desktop-activation.json'), JSON.stringify({ schemaVersion: 1, phase: 'committed',
  previousReleaseId: '0.1.7-internal-edfce49b', candidateReleaseId: previous.releaseId,
  applicationPath: app, stagedApplicationPath: join(root, 'upgrades/old-stage/MetaWork.app'), backupApplicationPath: `${app}.old-backup` }));
await writeFile(join(root, 'upgrades/desktop-helper.lock'), '99999999');
await writeFile(join(root, 'upgrades/desktop-update-status.json'), JSON.stringify({ schemaVersion: 1, operation: 'update', stage: 'verify',
  outcome: 'running', updatedAt: new Date().toISOString(), failures: [] }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await sleep(300); }
  throw new Error(message);
}
const json = path => readFile(path, 'utf8').then(JSON.parse, () => null);
function appPids() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').flatMap(row => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(row);
    return match && match[2].startsWith(`${app}/Contents/MacOS/MetaWork`) ? [Number(match[1])] : [];
  });
}
async function quit() {
  for (const pid of appPids()) process.kill(pid, 'SIGTERM');
  await until(() => appPids().length === 0, 'Fixture Desktop did not exit', 20000);
  // macOS cleans up a Finder application's coalition after the main exits.
  await sleep(2500);
}
let browser;
async function openFinder() {
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  execFileSync('/usr/bin/open', ['-n', '-a', app, ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--args', `--user-data-dir=${join(root, 'desktop-profile')}`, `--remote-debugging-port=${port}`]);
  await until(() => fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok, () => false), 'Finder launch failed');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return until(() => browser.contexts()[0]?.pages()[0], 'Finder window absent');
}
try {
  const page = await openFinder();
  await page.locator('#upgrade').waitFor({ state: 'visible', timeout: 120000 });
  assert.match(await page.locator('#status').innerText(), /已中断/u);
  assert.equal(await page.locator('#upgrade').innerText(), '完成更新并重启');
  await page.locator('#upgrade').click();
  let last = '';
  await until(async () => {
    const diagnostic = await json(join(root, 'upgrades/desktop-update-status.json'));
    if (JSON.stringify(diagnostic) !== last) { last = JSON.stringify(diagnostic); console.log(diagnostic); }
    if (['failed', 'rolled-back'].includes(diagnostic?.outcome)) throw new Error(`Update failed: ${last}`);
    const activation = await json(join(root, 'upgrades/desktop-activation.json'));
    return activation?.phase === 'committed' && activation.candidateReleaseId === descriptor.releaseId
      && diagnostic?.outcome === 'committed';
  }, 'Finder update did not commit', 300000);
  const health = await json(join(root, 'upgrades/desktop-shell-health.json'));
  assert.equal(health.releaseId, descriptor.releaseId);
  await browser?.close().catch(() => {});
  await quit();
  let endpoint = await json(join(root, 'server-endpoint.json'));
  assert(endpoint); process.kill(endpoint.pid, 0);
  // Explicitly stop, then let a Finder app start the Server to test independence.
  const manager = new DesktopServiceManager({ installRoot: root, releaseId: descriptor.releaseId, nodePath: node, configHome: env.METAWORK_CONFIG_HOME, env });
  await manager.stopForUpdate();
  let serverPid;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = await openFinder();
    await reopened.locator('.workspace-shell').waitFor({ state: 'visible', timeout: 120000 });
    assert.equal(await reopened.evaluate(async () => (await (await fetch('/api/auth/session')).json()).authenticated), true);
    endpoint = await json(join(root, 'server-endpoint.json'));
    if (serverPid) assert.equal(endpoint.pid, serverPid, 'reopening Desktop must reuse Server');
    serverPid = endpoint.pid;
    await browser.close(); browser = undefined;
    await quit(); process.kill(serverPid, 0);
    assert.equal((await json(join(root, 'app/current/release-identity.json'))).releaseId, descriptor.releaseId);
  }
  const retained = new Database(dbPath, { readonly: true });
  assert.deepEqual(retained.prepare('SELECT value FROM desktop_finder_acceptance').get(), { value: 'preserved work' }); retained.close();
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).contentHash, configHash);
  assert.equal(await access(join(root, 'upgrades/desktop-helper.lock')).then(() => true, () => false), false);
  await writeFile(join(fixture, 'finder-evidence.json'), JSON.stringify({ releaseId: descriptor.releaseId,
    launch: 'LaunchServices', historicalJournal: true, staleHelper: true, authenticatedRender: true,
    repeatLaunches: 2, serverSurvivesFinderQuit: true, configurationAndWorkPreserved: true }, null, 2));
  console.log('PASS: Finder upgrade, retained data, two restarts, independent Server');
} finally {
  await browser?.close().catch(() => {});
  await quit().catch(() => {});
  const identity = await json(join(root, 'app/current/release-identity.json'));
  if (identity) await new DesktopServiceManager({ installRoot: root, releaseId: identity.releaseId, nodePath: node,
    configHome: env.METAWORK_CONFIG_HOME, env }).stopForUpdate().catch(() => {});
}
