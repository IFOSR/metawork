// Disposable installed transaction acceptance. Fault fixtures are signed with
// the same ephemeral CI key and are never uploaded as release candidates.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { _electron } from '../apps/desktop/node_modules/playwright-core/index.mjs';
import { canonicalizeReleaseManifestPayload } from '../dist/installation/release-manifest.js';
import { desktopInventory, verifyDesktopRelease } from '../apps/desktop/dist/release-tools.mjs';

const exec = promisify(execFile);
const pause = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(check, label, milliseconds = 600000) {
  const until = Date.now() + milliseconds;
  do {
    const value = await check();
    if (value) return value;
    await pause(100);
  } while (Date.now() < until);
  throw new Error(`Installed update acceptance timed out: ${label}`);
}
const json = path => readFile(path, 'utf8').then(JSON.parse);

export async function runWindowsDesktopUpdates({ application, installRoot, resources, signingKey, evidence, env }) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const base = await json(join(resources, 'desktop-release.json'));
  assert.equal(base.development, true);
  const key = await readFile(signingKey, 'utf8');
  const trustedKeys = await json(join(resources, 'trusted-release-keys.json'));
  const fixtureRoot = join(resolve(process.env.RUNNER_TEMP), 'desktop-update-fixtures');
  await mkdir(fixtureRoot, { recursive: false });
  const report = { passed: false, sourceCommit: base.sourceCommit, baseReleaseId: base.releaseId, scenarios: [] };
  const activationPath = join(installRoot, 'upgrades/desktop-activation.json');
  const signManifest = value => ({ ...value, signature: { algorithm: 'ed25519', keyId: base.signature.keyId,
    value: sign(null, Buffer.from(canonicalizeReleaseManifestPayload(value)), key).toString('base64') } });
  const taskStates = async () => {
    const release = await realpath(join(installRoot, 'app/current'));
    const Database = createRequire(join(release, 'package.json'))('better-sqlite3');
    const db = new Database(join(installRoot, 'accounts/local-default/data/anyfusion.db'), { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
      return db.prepare('SELECT id, status FROM tasks ORDER BY id').all();
    } finally { db.close(); }
  };
  const baselineTasks = await taskStates();
  assert.ok(baselineTasks.length >= 2, 'Real task history must precede update acceptance');
  const closeOwnedShells = async () => {
    // Exact executable path under this probe's unique install directory only.
    const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(application).toString('base64')}'));
      @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $p -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`;
    const { stdout } = await exec(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, windowsHide: true });
    const found = JSON.parse(stdout.trim() || '[]');
    for (const pid of Array.isArray(found) ? found : [found]) {
      await exec(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { env, windowsHide: true });
    }
    await pause(1000);
  };
  let app;
  try {
    let previous = base.releaseId;
    for (const [index, scenario] of ['healthy', 'unhealthy-web', 'interrupted'].entries()) {
      const releaseId = `${base.releaseId}.${index + 1}`;
      const fixture = join(fixtureRoot, scenario);
      const fixtureResources = join(fixture, 'resources');
      await cp(resources, fixtureResources, { recursive: true });
      if (scenario === 'unhealthy-web') {
        await writeFile(join(fixtureResources, 'payload/metawork/web/dist/index.html'), '<!doctype html><html><body><main>Unhealthy acceptance fixture</main></body></html>');
      }
      const descriptor = signManifest({ ...base, releaseId,
        runtimeManifest: signManifest({ ...base.runtimeManifest, releaseId }),
        files: scenario === 'unhealthy-web' ? await desktopInventory(join(fixtureResources, 'payload'), 'win32') : base.files });
      await writeFile(join(fixtureResources, 'desktop-release.json'), JSON.stringify(descriptor));
      await verifyDesktopRelease(fixtureResources, { trustedKeys, platform: 'win32', arch: 'x64', desktopVersion: base.desktopVersion, allowDevelopment: true });
      const shell = join(fixture, 'shell');
      await exec(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', '--config', 'packaging/electron-builder.windows.config.mjs',
        '--win', 'nsis', '--x64', '--publish', 'never', '--config.directories.output', shell], {
        cwd: resolve('apps/desktop'), env: { ...env, METAWORK_DESKTOP_RESOURCES: fixtureResources },
        windowsHide: true, timeout: 600000, maxBuffer: 8 * 1024 * 1024,
      });
      const installer = join(shell, 'MetaWork-win32-x64-setup.exe');
      app = await _electron.launch({ executablePath: application, env, timeout: 120000 });
      const page = await app.firstWindow();
      await page.locator('.workspace-shell').waitFor({ timeout: 120000 });
      const before = await json(join(installRoot, 'server-endpoint.json'));
      await app.evaluate(({ dialog, Menu }, candidate) => {
        globalThis.__mwUpdateConfirmation = false;
        globalThis.__mwUpdateError = false;
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [candidate] });
        dialog.showMessageBox = async (_window, options) => {
          globalThis.__mwUpdateConfirmation = options.buttons.includes('退出并更新')
            && options.detail.includes('未结束任务');
          return new Promise(done => { globalThis.__mwConfirmUpdate = done; });
        };
        dialog.showErrorBox = () => { globalThis.__mwUpdateError = true; };
        const item = Menu.getApplicationMenu().items[0].submenu.items.find(value => ['安装新版应用…', 'Install Update…'].includes(value.label));
        if (!item) throw new Error('Missing update menu');
        item.click();
      }, installer);
      await waitFor(async () => {
        const state = await app.evaluate(() => ({ confirmed: globalThis.__mwUpdateConfirmation, failed: globalThis.__mwUpdateError }));
        assert.equal(state.failed, false, 'Desktop rejected candidate preparation before impact confirmation');
        return state.confirmed;
      }, 'verified candidate and actual task-impact confirmation');
      await app.evaluate(() => globalThis.__mwConfirmUpdate({ response: 1, checkboxChecked: false }));
      if (scenario === 'interrupted') {
        await waitFor(async () => {
          const record = await json(activationPath).catch(() => null);
          return record?.candidateReleaseId === releaseId && record.phase === 'runtime-updated';
        }, 'interruptible runtime activation');
        const helper = Number(await readFile(join(installRoot, 'upgrades/desktop-helper.lock'), 'utf8'));
        assert.ok(Number.isSafeInteger(helper) && helper > 0);
        process.kill(helper, 'SIGKILL');
        await waitFor(() => { try { process.kill(helper, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 'helper exit', 30000);
        await app.close().catch(() => undefined);
        app = await _electron.launch({ executablePath: application, env, timeout: 120000 });
        await (await app.firstWindow()).locator('#retry:visible').waitFor({ timeout: 120000 });
        await app.evaluate(({ dialog, Menu }) => {
          dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
          const item = Menu.getApplicationMenu().items[0].submenu.items.find(value => ['修复未完成的更新…', 'Repair Interrupted Update…'].includes(value.label));
          if (!item) throw new Error('Missing recovery menu');
          item.click();
        });
      }
      const expectedPhase = scenario === 'healthy' ? 'committed' : 'rolled-back';
      const record = await waitFor(async () => {
        const value = await json(activationPath).catch(() => null);
        return value?.candidateReleaseId === releaseId && value.phase === expectedPhase ? value : null;
      }, `${scenario} terminal activation`);
      assert.equal(record.previousReleaseId, previous);
      if (scenario === 'healthy') previous = releaseId;
      const identity = await json(join(installRoot, 'app/current/release-identity.json'));
      assert.equal(identity.releaseId, previous);
      const endpoint = await json(join(installRoot, 'server-endpoint.json'));
      assert.notEqual(endpoint.pid, before.pid);
      if (scenario === 'healthy') {
        const receipt = await json(join(installRoot, 'upgrades/desktop-shell-health.json'));
        assert.equal(receipt.releaseId, previous);
        assert.ok(typeof receipt.instanceId === 'string' && receipt.instanceId.length > 0);
        const request = await json(join(installRoot, 'upgrades/desktop-request.json'));
        assert.equal(receipt.challenge, request.shellChallenge);
        process.kill(receipt.pid, 0);
      }
      await app.close().catch(() => undefined); app = undefined;
      await closeOwnedShells();
      process.kill(endpoint.pid, 0);
      app = await _electron.launch({ executablePath: application, env, timeout: 120000 });
      const restoredPage = await app.firstWindow();
      await restoredPage.locator('.workspace-shell').waitFor({ timeout: 120000 });
      assert.equal(await restoredPage.evaluate(async () => (await (await fetch('/api/auth/session')).json()).authenticated), true);
      assert.deepEqual(await taskStates(), baselineTasks);
      await restoredPage.screenshot({ path: join(evidence, `update-${scenario}.png`) });
      await app.close(); app = undefined;
      report.scenarios.push({ scenario, expectedPhase, previousReleaseId: record.previousReleaseId, candidateReleaseId: releaseId,
        activeReleaseId: previous, impactConfirmed: true, tasksPreserved: true, authenticatedWorkspace: true });
      console.log(`Installed Windows ${scenario} activation acceptance passed.`);
      await rm(fixture, { recursive: true, force: true });
    }
    report.passed = true;
  } finally {
    await app?.close().catch(() => undefined);
    report.activationPhase = (await json(activationPath).catch(() => null))?.phase;
    if (!report.passed) report.failure = await json(join(installRoot, 'upgrades/desktop-update-failure.json')).catch(() => undefined);
    await writeFile(join(evidence, 'desktop-updates.json'), JSON.stringify(report, null, 2));
  }
}
