import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { _electron } from 'playwright-core';
import { verifyDesktopMenu } from './menu-smoke.mjs';

// Clean-install smoke of the signed app; no model requests or paid task execution.
const application = resolve(process.argv[2] ?? '');
if (!application.endsWith('/MetaWork.app')) throw new Error('Supply the packaged MetaWork.app path');
// Darwin's default temporary root can exceed the Unix socket path limit.
const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'metawork-install-'));
const installRoot = join(root, 'installation');
await mkdir(join(root, 'empty-home'));
const env = { ...process.env, PATH: '/usr/bin:/bin',
  HOME: join(root, 'empty-home'),
  METAWORK_INSTALL_ROOT: installRoot, ANYFUSION_INSTALL_ROOT: installRoot,
  METAWORK_CONFIG_HOME: join(root, 'config'), ANYFUSION_CONFIG_HOME: join(root, 'config'),
  METAWORK_SECRET_STORE: 'file', ANYFUSION_SECRET_STORE: 'file',
  METAWORK_WEB_PORT: '0', METACLAW_DISABLE_MARKDOWN_PREVIEW: '1',
  METAWORK_INTERNAL_LLM_SOURCE_ROOT: join(root, 'absent-developer-configuration') };
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE',
  'METAWORK_DESKTOP_DEVELOPMENT_ROOT', 'METAWORK_DESKTOP_DEVELOPMENT', 'METAWORK_DESKTOP_UI_ORIGIN']) delete env[key];
const launch = () => _electron.launch({ executablePath: join(application, 'Contents/MacOS/MetaWork'),
  args: [`--user-data-dir=${join(root, 'desktop-profile')}`], env, timeout: 120000 });
let app = await launch();
let serverPid;
try {
  let page = await app.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/, { timeout: 180000 });
  await page.locator('.workspace-shell').waitFor({ timeout: 30000 });
  const authenticated = await page.evaluate(async () => (await (await fetch('/api/auth/session')).json()).authenticated);
  assert.equal(authenticated, true);
  const initial = await page.evaluate(async () => (await (await fetch('/api/config')).json()));
  assert.deepEqual(initial.config.providers, {});
  assert.deepEqual(initial.config.models, {});
  assert(Object.values(initial.config.agentClasses).every(agent => !agent.enabled));
  await page.getByRole('button', { name: '配置模型', exact: true }).waitFor();
  await page.getByRole('button', { name: '配置模型', exact: true }).click();
  await page.getByRole('button', { name: '保存并激活', exact: true }).waitFor();
  // Saving the empty configuration must remain possible; disabled presets do not
  // require invented model references or credentials.
  const saved = page.waitForResponse(response => response.url().endsWith('/api/config/activate'));
  await page.getByRole('button', { name: '保存并激活', exact: true }).click();
  assert.equal((await saved).status(), 200);
  assert.equal((await (await saved).json()).ok, true);
  assert.equal((await page.evaluate(async () => (await (await fetch('/api/config/activation-status')).json()))).workConfigurationReady, false);
  if (process.env.METAWORK_SMOKE_MANAGED_TOOLS === '1') {
    const command = join(root, 'codex fixture');
    await writeFile(command, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 1.0.0"; else echo "exec --json"; fi\n', { mode: 0o755 });
    // The native picker supplies an absolute path; the UI has no manual input.
    await app.evaluate(({ dialog }, filePath) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original;
        return { canceled: false, filePaths: [filePath] };
      };
    }, command);
    await page.getByRole('button', { name: '选择程序', exact: true }).click();
    await page.getByText('待保存', { exact: true }).waitFor();
    const selected = page.waitForResponse(response => response.url().endsWith('/api/config/activate'));
    await page.getByRole('button', { name: '保存并激活', exact: true }).click();
    assert.equal((await (await selected).json()).ok, true);
    const tools = await page.evaluate(async () => (await (await fetch('/api/agents/readiness/refresh', { method: 'POST' })).json()).agents);
    assert.equal(tools.find(tool => tool.agentId === 'codex-cli').path, command);
    assert.equal(tools.find(tool => tool.agentId === 'codex-cli').status, 'installed');
    assert.equal(tools.find(tool => tool.agentId === 'pi-agent').managed, true);
    await page.locator('.executor-tools').screenshot({ path: join(root, 'managed-tools-settings.png') });
  }
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await verifyDesktopMenu(app);
  await assert.rejects(access(join(installRoot, 'internal/llm-credentials.json')));
  serverPid = JSON.parse(await readFile(join(installRoot, 'server-endpoint.json'), 'utf8')).pid;
  await page.reload();
  await page.locator('.workspace-shell').waitFor({ timeout: 30000 });
  const evidence = resolve('apps/desktop/release/evidence'); await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, 'packaged-install.png') });
  // Exercise the real shared Settings activation transaction, without an LLM request.
  const activation = await page.evaluate(async () => {
    const initial = await (await fetch('/api/config')).json();
    const config = structuredClone(initial.config);
    config.providers.fixture = { protocol: 'openai-compatible', baseUrl: 'https://provider.example.invalid/v1',
      apiKeyRef: 'file-secret:anyfusion/providers/fixture', region: 'international', enabled: true };
    config.models.fixture = { providerRef: 'fixture', modelId: 'deepseek-chat',
      capabilities: ['planning', 'structured-output', 'tools', 'coding'], reasoning: 'high',
      costInputPerMillion: 2, costOutputPerMillion: 3, enabled: true };
    for (const ref of ['planner', 'pi-engineering']) {
      config.agentClasses[ref].enabled = true;
      config.agentClasses[ref].modelPolicy = { mode: 'fixed', modelRef: 'fixture' };
    }
    const activate = body => fetch('/api/config/activate', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const failed = await activate({ baseRevisionId: initial.revisionId, config });
    const failedBody = await failed.json();
    const afterFailure = await (await fetch('/api/config')).json();
    const saved = await activate({ baseRevisionId: initial.revisionId, config,
      secrets: { fixture: 'isolated-activation-test' } });
    const savedBody = await saved.json();
    const after = await (await fetch('/api/config')).json();
    return { failedBody, failurePreservedRevision: afterFailure.revisionId === initial.revisionId,
      failureReady: afterFailure.workConfigurationReady, savedStatus: saved.status, savedBody,
      ready: after.workConfigurationReady };
  });
  assert.equal(activation.failedBody.ok, false);
  assert.equal(activation.failedBody.code, 'probe_failed');
  assert.equal(activation.failurePreservedRevision, true);
  assert.equal(activation.failureReady, false);
  assert.equal(activation.savedStatus, 200, JSON.stringify(activation.savedBody));
  assert.equal(activation.savedBody.ok, true, JSON.stringify(activation.savedBody));
  assert.equal(activation.ready, true);
  await page.getByRole('button', { name: '配置模型', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(JSON.parse(await readFile(join(installRoot, 'server-endpoint.json'), 'utf8')).pid, serverPid);
  if (process.env.METAWORK_SMOKE_MANAGED_TOOLS === '1') {
    const pi = join(installRoot, 'app/current/desktop-tools/executor/bin/pi');
    await chmod(pi, 0o755); await writeFile(pi, '#!/bin/sh\nexit 1\n');
    // Exercise the real next-launch check. A reconnect during an existing
    // connection's inventory scan is intentionally coalesced with that scan.
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    const deadline = Date.now() + 120000;
    let restored = false;
    while (Date.now() < deadline) {
      try {
        const tools = await page.evaluate(async () => (await (await fetch('/api/agents/readiness/refresh', { method: 'POST' })).json()).agents);
        const currentPi = tools.find(tool => tool.agentId === 'pi-agent');
        if (currentPi.status === 'installed' && currentPi.path.includes('-tools-')) { restored = true; break; }
      } catch { /* Server and Renderer reconnect through the normal lifecycle. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(restored, true, 'damaged managed Pi must recover without updating the app');
    serverPid = JSON.parse(await readFile(join(installRoot, 'server-endpoint.json'), 'utf8')).pid;
  }
  await app.close();
  process.kill(serverPid, 0);
  await writeFile(join(evidence, 'packaged-install.json'), JSON.stringify({
    application, authenticated, cleanInstall: true, modelFreeInstallation: true, settingsAccessible: true, firstActivationWithoutRestart: true, failedProbePreservedState: true, developerCredentialsAbsent: true,
    restrictedPath: env.PATH, isolatedHome: true, serverSurvivedExit: true, paidTaskExecuted: false,
    managedToolAcceptance: process.env.METAWORK_SMOKE_MANAGED_TOOLS === '1',
  }, null, 2));
  console.log('Packaged Desktop clean installation, authenticated Web and Server survival passed.');
} finally {
  await app.close().catch(() => undefined);
  const node = join(installRoot, 'app/current/desktop-tools/node/bin/node');
  const cli = join(installRoot, 'app/current/dist/index.js');
  if (await access(cli).then(() => true, () => false)) {
    await promisify(execFile)(node, [cli, 'server', 'stop'], { env, cwd: installRoot, timeout: 30000 });
  }
}
