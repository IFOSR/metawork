import assert from 'node:assert/strict';
import { access, cp, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import Database from 'better-sqlite3';

// The fixture is a disposable packaged app with an ephemeral local signing key.
const root = resolve(process.argv[2] ?? '.tmp/desktop-adoption-acceptance');
const { SourceNativeInstaller, resolveMetaWorkPaths, createProductionSecretStore, DesktopServiceManager, commandExistsOnPath } =
  await import(pathToFileURL(join(root, 'fixture-tools.mjs')).href);
const application = join(root, 'MetaWork.app');
const resources = join(application, 'Contents/Resources');
const payload = join(resources, 'payload');
const descriptor = JSON.parse(await readFile(join(resources, 'desktop-release.json'), 'utf8'));
const nativeSource = join(root, 'native-source');
if (!await access(nativeSource).then(() => true, () => false)) {
  await cp(join(payload, 'metawork'), nativeSource, { recursive: true,
    filter: path => path !== join(payload, 'metawork/desktop-tools') });
}
const node = join(payload, 'metawork/desktop-tools/node/bin/node');
const toolsPath = ['node', 'git', 'executor'].map(name => join(payload, 'metawork/desktop-tools', name, 'bin')).join(':');
const baselineEnvironment = { ...process.env };
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'METAWORK_DESKTOP_DEVELOPMENT_ROOT',
  'METAWORK_DESKTOP_DEVELOPMENT', 'METAWORK_DESKTOP_UI_ORIGIN', 'ANYFUSION_PLANNER_WORKSPACE', 'METACLAW_PLANNER_WORKDIR']) {
  delete baselineEnvironment[key];
}
const evidence = [];
// macOS Unix socket paths (including Planner's filename) must fit in 104 bytes.
const runRoot = process.argv[3] ? resolve(process.argv[3]) : resolve('.tmp', `adopt-${Date.now().toString(36)}`);
const scenarios = process.argv[4] ? [process.argv[4]] : ['reuse', 'upgrade'];
if (scenarios.some(value => !['reuse', 'upgrade'].includes(value))) throw new Error('Unknown scenario');
for (const scenario of scenarios) {
  const installationRoot = join(runRoot, scenario);
  const releaseId = scenario === 'reuse' ? descriptor.releaseId : '1.2.0-preview.3-build-e33e516-1789389295';
  const env = { ...baselineEnvironment, PATH: `${toolsPath}:/usr/bin:/bin`, METAWORK_INSTALL_ROOT: installationRoot,
    ANYFUSION_INSTALL_ROOT: installationRoot, METAWORK_CONFIG_HOME: join(installationRoot, 'user-config'),
    ANYFUSION_CONFIG_HOME: join(installationRoot, 'user-config'), METAWORK_WEB_PORT: '0',
    METAWORK_SECRET_STORE: 'file', ANYFUSION_SECRET_STORE: 'file', METACLAW_DISABLE_MARKDOWN_PREVIEW: '1',
    METAWORK_INTERNAL_LLM_SOURCE_ROOT: join(root, 'absent-internal-config') };
  Object.assign(process.env, env);
  const paths = resolveMetaWorkPaths(undefined, installationRoot);
  const database = join(installationRoot, 'accounts/local-default/data/anyfusion.db');
  console.log(`Preparing native ${scenario} fixture`);
  if (!await access(database).then(() => true, () => false)) {
    await new SourceNativeInstaller({ paths, secretStore: createProductionSecretStore({ credentialsFile: paths.credentials }),
    detectCommand: name => commandExistsOnPath(name, env.PATH), installLaunchers: false }).install({ releaseId, sourceRoot: nativeSource, plannerRoot: join(payload, 'planner'),
    executorPreset: 'desktop-pi', provider: { baseUrl: 'https://provider.example.invalid/v1', modelId: 'deepseek-chat',
      apiKey: 'existing-user-fixture', region: 'international', secretReference: 'file-secret:anyfusion/providers/provider' } });
    const db = new Database(database);
    db.exec("CREATE TABLE desktop_adoption_acceptance (value TEXT); INSERT INTO desktop_adoption_acceptance VALUES ('existing work');");
    db.close();
  }
  const configuration = await readlink(join(installationRoot, 'accounts/local-default/config/active'));
  const manager = new DesktopServiceManager({ installRoot: installationRoot, releaseId, nodePath: node,
    configHome: env.METAWORK_CONFIG_HOME, env });
  await manager.startForUpdate();
  // Native startup may import missing local Agent credentials before Desktop attaches.
  const credentials = await readFile(paths.credentials, 'utf8');
  console.log(`Native ${scenario} Server ready; opening Desktop`);
  const previous = JSON.parse(await readFile(join(installationRoot, 'server-endpoint.json'), 'utf8'));
  let app;
  let candidatePid;
  let diagnostics = '';
  try {
    app = await _electron.launch({ executablePath: join(application, 'Contents/MacOS/MetaWork'),
      args: [`--user-data-dir=${join(installationRoot, 'desktop-profile')}`], env, timeout: 120000 });
    app.process().stderr?.on('data', data => { diagnostics = (diagnostics + String(data)).slice(-10000); });
    const page = await app.firstWindow();
    let lastState = '';
    const statusTimer = setInterval(() => {
      void page.evaluate(() => window.metaworkShell?.state()).then(state => {
        if (state && JSON.stringify(state) !== lastState) {
          lastState = JSON.stringify(state);
          console.log('Desktop state:', state);
        }
      }).catch(() => undefined);
    }, 15000);
    app.on('close', () => clearInterval(statusTimer));
    if (scenario === 'reuse') {
      const deadline = Date.now() + 180000;
      while (!await page.locator('.workspace-shell').count()) {
        const shellState = await page.evaluate(() => window.metaworkShell?.state()).catch(() => null);
        if (shellState?.phase === 'error') throw new Error(shellState.message);
        if (Date.now() > deadline) throw new Error('Desktop workspace did not become ready');
        await page.waitForTimeout(250);
      }
      assert.equal(await page.evaluate(async () => (await (await fetch('/api/auth/session')).json()).authenticated), true);
      assert.equal(JSON.parse(await readFile(join(installationRoot, 'server-endpoint.json'), 'utf8')).pid, previous.pid);
    } else {
      await page.locator('#upgrade').waitFor({ state: 'visible', timeout: 120000 });
      await page.screenshot({ path: join(runRoot, 'upgrade-prompt.png') });
      console.log('Upgrade action visible; checking cancellation');
      assert.equal(await page.locator('#setup').isVisible(), false);
      await app.evaluate(({ dialog }) => {
        globalThis.adoptionDialogCount = 0;
        dialog.showMessageBox = async () => { ++globalThis.adoptionDialogCount; return { response: 0, checkboxChecked: false }; };
      });
      await page.locator('#upgrade').click();
      await page.locator('#upgrade').waitFor({ state: 'hidden' });
      await page.locator('#upgrade').waitFor({ state: 'visible', timeout: 240000 });
      assert.equal(await app.evaluate(() => globalThis.adoptionDialogCount), 1);
      assert.equal(JSON.parse(await readFile(join(installationRoot, 'server-endpoint.json'), 'utf8')).pid, previous.pid);
      assert.equal(JSON.parse(await readFile(join(installationRoot, 'app/current/release-identity.json'), 'utf8')).releaseId, releaseId);
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => { ++globalThis.adoptionDialogCount; return { response: 1, checkboxChecked: false }; };
      });
      console.log('Cancellation preserved native Server; accepting upgrade');
      await page.locator('#upgrade').click();
      const deadline = Date.now() + 300000;
      let phase;
      do {
        await new Promise(resolve => setTimeout(resolve, 1000));
        phase = await readFile(join(installationRoot, 'upgrades/desktop-activation.json'), 'utf8').then(raw => JSON.parse(raw).phase, () => null);
        if (phase === 'rolled-back') throw new Error('Desktop adoption rolled back');
        if (!phase && await page.evaluate(() => window.metaworkShell?.state()).then(state => state?.phase === 'upgrade', () => false)) {
          throw new Error('Upgrade did not launch its helper');
        }
      } while (phase !== 'committed' && Date.now() < deadline);
      assert.equal(phase, 'committed');
      const health = JSON.parse(await readFile(join(installationRoot, 'upgrades/desktop-shell-health.json'), 'utf8'));
      candidatePid = health.pid;
      assert.equal(health.releaseId, descriptor.releaseId);
      assert.equal(JSON.parse(await readFile(join(installationRoot, 'app/current/release-identity.json'), 'utf8')).releaseId, descriptor.releaseId);
    }
    const retained = new Database(database, { readonly: true });
    try { assert.deepEqual(retained.prepare('SELECT value FROM desktop_adoption_acceptance').get(), { value: 'existing work' }); }
    finally { retained.close(); }
    assert.equal(await readlink(join(installationRoot, 'accounts/local-default/config/active')), configuration);
    assert.ok(await readFile(paths.credentials, 'utf8') === credentials, 'Desktop must preserve native credentials');
    evidence.push({ scenario, authenticatedRender: true, configurationPreserved: true, credentialsPreserved: true, workPreserved: true });
    console.log(`Passed native ${scenario}: authenticated Desktop and preserved account data`);
  } catch (error) {
    console.error(await app?.firstWindow().then(page => page.locator('body').innerText({ timeout: 1000 })).catch(() => 'Window closed'));
    console.error(diagnostics);
    throw error;
  } finally {
    await app?.close().catch(() => undefined);
    if (candidatePid) { try { process.kill(candidatePid, 'SIGTERM'); } catch {} }
    const identity = JSON.parse(await readFile(join(installationRoot, 'app/current/release-identity.json'), 'utf8'));
    await new DesktopServiceManager({ installRoot: installationRoot, releaseId: identity.releaseId, nodePath: node,
      configHome: env.METAWORK_CONFIG_HOME, env }).stopForUpdate();
  }
}
await mkdir(join(root, 'evidence'), { recursive: true });
await writeFile(join(root, 'evidence/existing-runtime.json'), JSON.stringify(evidence, null, 2));
