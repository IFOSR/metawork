import assert from 'node:assert/strict';
import { access, cp, mkdir, readFile, readlink, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright-core';
import Database from 'better-sqlite3';

// The fixture is a disposable packaged app with an ephemeral local signing key.
// Usage: node apps/desktop/tests/customer-upgrade-smoke.mjs <fixture-directory>
//   <short-disposable-run-directory> upgrade <actual-previous-runtime> [failure-repair]
// The fixture directory contains a disposable MetaWork.app and fixture-tools.mjs.
if (!process.argv[2] || !process.argv[3] || !process.argv[5]) throw new Error('Supply fixture, run directory and actual previous Runtime');
const root = resolve(process.argv[2]);
const { SourceNativeInstaller, resolveMetaWorkPaths, createProductionSecretStore, DesktopServiceManager, commandExistsOnPath } =
  await import(pathToFileURL(join(root, 'fixture-tools.mjs')).href);
const application = join(root, 'MetaWork.app');
const resources = join(application, 'Contents/Resources');
const payload = join(resources, 'payload');
const descriptor = JSON.parse(await readFile(join(resources, 'desktop-release.json'), 'utf8'));
const nativeSource = resolve(process.argv[5]);
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
const interruptedMode = process.argv[6] === 'interrupt-repair';
const faultMode = interruptedMode || process.argv[6] === 'failure-repair';
// macOS Unix socket paths (including Planner's filename) must fit in 104 bytes.
const runRoot = resolve(process.argv[3]);
if (!runRoot.startsWith(resolve('.tmp') + '/') && !runRoot.startsWith('/tmp/metawork-')) {
  throw new Error('Use a disposable run directory under .tmp or /tmp/metawork-*');
}
const scenarios = process.argv[4] ? [process.argv[4]] : ['reuse', 'upgrade'];
if (scenarios.some(value => !['reuse', 'upgrade'].includes(value))) throw new Error('Unknown scenario');
for (const scenario of scenarios) {
  const installationRoot = join(runRoot, scenario);
  const releaseId = scenario === 'reuse' ? descriptor.releaseId : JSON.parse(await readFile(join(nativeSource, 'release-identity.json'), 'utf8')).releaseId;
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
    detectCommand: name => commandExistsOnPath(name, env.PATH), installLaunchers: false }).install({ releaseId, sourceRoot: nativeSource, plannerRoot: join(nativeSource, 'planner'),
    executorPreset: 'desktop-pi', provider: { baseUrl: 'https://provider.example.invalid/v1', modelId: 'deepseek-chat',
      apiKey: 'existing-user-fixture', region: 'international', secretReference: 'file-secret:anyfusion/providers/provider' } });
    const db = new Database(database);
    db.exec("CREATE TABLE desktop_adoption_acceptance (value TEXT); INSERT INTO desktop_adoption_acceptance VALUES ('existing work');");
    db.close();
  }
  const configuration = await readFile(join(installationRoot, 'accounts/local-default/config/active/revision-manifest.json'), 'utf8').then(JSON.parse);
  const manager = new DesktopServiceManager({ installRoot: installationRoot, releaseId, nodePath: node,
    configHome: env.METAWORK_CONFIG_HOME, env });
  await manager.startForUpdate();
  // Native startup may import missing local Agent credentials before Desktop attaches.
  const credentials = await readFile(paths.credentials, 'utf8');
  console.log(`Native ${scenario} Server ready; opening Desktop`);
  const previous = JSON.parse(await readFile(join(installationRoot, 'server-endpoint.json'), 'utf8'));
  let app;
  let candidatePid;
  try {
    app = await _electron.launch({ executablePath: join(application, 'Contents/MacOS/MetaWork'),
      args: [`--user-data-dir=${join(installationRoot, 'desktop-profile')}`], env: { ...env, PATH: '/usr/bin:/bin' }, timeout: 120000 });
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
      let blocker;
      if (faultMode) {
        blocker=createServer();await new Promise(resolve=>blocker.listen(0,'127.0.0.1',resolve));
        await app.evaluate((_,port)=>{process.env.METAWORK_WEB_PORT=String(port);},blocker.address().port);
      }
      console.log('Cancellation preserved native Server; accepting upgrade');
      await page.locator('#upgrade').click();
      const deadline = Date.now() + 300000;
      let phase;
      let interrupted = false;
      do {
        await new Promise(resolve => setTimeout(resolve, 1000));
        phase = await readFile(join(installationRoot, 'upgrades/desktop-activation.json'), 'utf8').then(raw => JSON.parse(raw).phase, () => null);
        if (faultMode) {
          const status=await readFile(join(installationRoot,'upgrades/desktop-update-status.json'),'utf8').then(JSON.parse,()=>null);
          if (interruptedMode && !interrupted && phase === 'shell-replaced' && status?.stage === 'startAndVerifyCandidate') {
            const helperPid = Number(await readFile(join(installationRoot, 'upgrades/desktop-helper.lock'), 'utf8'));
            process.kill(helperPid, 'SIGKILL');
            await new Promise(resolve => blocker.close(resolve)); blocker = null;
            const requestPath = join(installationRoot, 'upgrades/desktop-request.json');
            const request = JSON.parse(await readFile(requestPath, 'utf8'));
            // Lost staging/helper simulates interrupted upgrade cleanup. Only
            // this disposable fixture is changed, never a user's installation.
            await rename(request.record.stagedApplicationPath, `${request.record.stagedApplicationPath}.unavailable`);
            request.bootstrap = join(installationRoot, 'missing-helper');
            request.previousNode = join(installationRoot, 'missing-node');
            await writeFile(requestPath, JSON.stringify(request));
            interrupted = true;
            console.log('Interrupted the helper; previous staging/helper made unavailable');
            break;
          }
          if(blocker && status && ['restoreRuntime','restoreShell','startPrevious'].includes(status.stage)) {
            await new Promise(resolve=>blocker.close(resolve));blocker=null;console.log('Released injected port conflict for rollback');
          }
          if(phase==='rolled-back') break;
        } else if (phase === 'rolled-back') throw new Error('Desktop adoption rolled back');
        if (!phase && await page.evaluate(() => window.metaworkShell?.state()).then(state => state?.phase === 'upgrade', () => false)) {
          throw new Error('Upgrade did not launch its helper');
        }
      } while (phase !== 'committed' && Date.now() < deadline);
      if(faultMode) {
        assert.equal(phase, interruptedMode ? 'shell-replaced' : 'rolled-back');
        await new Promise(resolve=>setTimeout(resolve,1200));
        if (!interruptedMode) assert.equal(await access(join(installationRoot,'upgrades/desktop-helper.lock')).then(()=>true,()=>false),false);
        const status=JSON.parse(await readFile(join(installationRoot,'upgrades/desktop-update-status.json'),'utf8'));
        if (!interruptedMode) {
          assert.equal(status.outcome, 'rolled-back');
          assert.equal(status.failures[0].stage, 'startAndVerifyCandidate');
          assert.equal(status.failures[0].code, 'runtime-not-ready');
        }
        async function reopen(){
          for(const row of execFileSync('ps',['-axo','pid,command'],{encoding:'utf8'}).split('\n')){
            const match=/^\s*(\d+)\s+(.+)$/.exec(row);
            if(match && match[2].startsWith(join(application,'Contents/MacOS/MetaWork')+' ') && match[2].includes('--user-data-dir='+join(installationRoot,'desktop-profile'))) {
              try{process.kill(Number(match[1]),'SIGTERM');}catch{}
            }
          }
          await new Promise(resolve=>setTimeout(resolve,800));
          return _electron.launch({executablePath:join(application,'Contents/MacOS/MetaWork'),args:['--user-data-dir='+join(installationRoot,'desktop-profile')],env:{...env,PATH:'/usr/bin:/bin'},timeout:120000});
        }
        app=await reopen();let recovered=await app.firstWindow();
        await recovered.locator(interruptedMode ? '#retry' : '#upgrade').waitFor({state:'visible',timeout:120000});
        assert((await recovered.locator('#status').innerText()).includes(interruptedMode ? '修复未完成' : '已恢复'));
        await recovered.screenshot({path:join(runRoot,'recovered-upgrade.png')});
        console.log('Failed upgrade restored usable upgrade UI and safe diagnostic');
        const before=await readFile(join(installationRoot,'upgrades/desktop-activation.json'),'utf8');
        await app.evaluate(({dialog,Menu})=>{
          dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});
          Menu.getApplicationMenu().items[0].submenu.items.find(i=>/Repair Interrupted|修复未完成/.test(i.label)).click();
        });
        await new Promise(resolve=>app.once('close',resolve));
        const repairDeadline=Date.now()+180000;
        while(Date.now()<repairDeadline){
          const d=await readFile(join(installationRoot,'upgrades/desktop-update-status.json'),'utf8').then(JSON.parse,()=>null);
          if(d?.operation==='repair' && d.outcome==='rolled-back' && !await access(join(installationRoot,'upgrades/desktop-helper.lock')).then(()=>true,()=>false))break;
          await new Promise(resolve=>setTimeout(resolve,500));
        }
        const afterRepair = await readFile(join(installationRoot,'upgrades/desktop-activation.json'),'utf8');
        if (interruptedMode) assert.equal(JSON.parse(afterRepair).phase, 'rolled-back');
        else assert.equal(afterRepair, before);
        console.log('Repair of completed rollback did not repeat the upgrade');
        app=await reopen();recovered=await app.firstWindow();
        await recovered.locator('#upgrade').waitFor({state:'visible',timeout:120000});
        await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
        await recovered.locator('#upgrade').click();
        const retryDeadline=Date.now()+240000;
        while(Date.now()<retryDeadline){
          phase=await readFile(join(installationRoot,'upgrades/desktop-activation.json'),'utf8').then(r=>JSON.parse(r).phase,()=>null);
          if(phase==='committed')break;
          await new Promise(resolve=>setTimeout(resolve,500));
        }
        evidence.push({scenario:interruptedMode ? 'interrupt-repair-retry' : 'failure-repair-retry',rollback:true,repairDidNotReapply:true,subsequentUpgrade:phase});
      }
      assert.equal(phase, 'committed');
      const health = JSON.parse(await readFile(join(installationRoot, 'upgrades/desktop-shell-health.json'), 'utf8'));
      candidatePid = health.pid;
      assert.equal(health.releaseId, descriptor.releaseId);
      assert.equal(JSON.parse(await readFile(join(installationRoot, 'app/current/release-identity.json'), 'utf8')).releaseId, descriptor.releaseId);
    }
    const retained = new Database(database, { readonly: true });
    try { assert.deepEqual(retained.prepare('SELECT value FROM desktop_adoption_acceptance').get(), { value: 'existing work' }); }
    finally { retained.close(); }
    const finalConfig=JSON.parse(await readFile(join(installationRoot, 'accounts/local-default/config/active/revision-manifest.json'), 'utf8'));
    assert.equal(finalConfig.contentHash,configuration.contentHash);
    assert.ok(await readFile(paths.credentials, 'utf8') === credentials, 'Desktop must preserve native credentials');
    evidence.push({ scenario, authenticatedRender: true, configurationPreserved: true, credentialsPreserved: true, workPreserved: true });
    console.log(`Passed native ${scenario}: authenticated Desktop and preserved account data`);
  } catch (error) {
    console.error(await app?.firstWindow().then(page => page.locator('body').innerText({ timeout: 1000 })).catch(() => 'Window closed'));
    console.error('Electron diagnostic output withheld; inspect the fixture startup log for safe stage codes.'); console.error('Startup diagnostics:', await readFile(join(installationRoot, 'desktop-profile/startup.log'), 'utf8').catch(() => 'absent'));
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
