import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { _electron } from 'playwright-core';
import { runPackagedModelTasks } from './packaged-model-task.mjs';

// Fixture smoke by default; NSIS acceptance explicitly enables real model tasks.
const application = resolve(process.argv[2] ?? '');
const windows = process.platform === 'win32';
const realTasks = process.env.METAWORK_PACKAGED_REAL_TASK === '1';
let provider = { baseUrl: 'https://provider.example.invalid/v1', modelId: 'deepseek-chat', apiKey: 'packaged-install-fixture' };
if (realTasks) {
  try {
    const value = JSON.parse(process.env.METAWORK_TEST_MODEL ?? '');
    if (!value || !['baseUrl', 'modelId', 'apiKey'].every(key => typeof value[key] === 'string' && value[key].trim())
      || !['https:', 'http:'].includes(new URL(value.baseUrl).protocol)) throw new Error();
    provider = { baseUrl: value.baseUrl, modelId: value.modelId, apiKey: value.apiKey };
  } catch { throw new Error('Real task acceptance requires METAWORK_TEST_MODEL JSON with baseUrl, modelId and apiKey'); }
}
if (windows ? basename(application) !== 'MetaWork.exe' : !application.endsWith('/MetaWork.app')) {
  throw new Error('Supply the packaged MetaWork application path');
}
const root = process.env.METAWORK_PACKAGED_SMOKE_ROOT
  ? resolve(process.env.METAWORK_PACKAGED_SMOKE_ROOT)
  : await mkdtemp(join(tmpdir(), 'metawork-packaged-install-'));
if (process.env.METAWORK_PACKAGED_SMOKE_ROOT) await mkdir(root, { recursive: true });
const installRoot = join(root, 'installation');
const env = { ...process.env,
  METAWORK_INSTALL_ROOT: installRoot, ANYFUSION_INSTALL_ROOT: installRoot,
  METAWORK_CONFIG_HOME: join(root, 'config'), ANYFUSION_CONFIG_HOME: join(root, 'config'),
  METAWORK_SECRET_STORE: 'file', ANYFUSION_SECRET_STORE: 'file',
  METAWORK_WEB_PORT: '0', METACLAW_DISABLE_MARKDOWN_PREVIEW: '1',
  METAWORK_INTERNAL_LLM_SOURCE_ROOT: join(root, 'absent-developer-configuration') };
delete env.METAWORK_TEST_MODEL;
for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
env.PATH = windows ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` : '/usr/bin:/bin';
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE',
  'METAWORK_DESKTOP_DEVELOPMENT_ROOT', 'METAWORK_DESKTOP_DEVELOPMENT', 'METAWORK_DESKTOP_UI_ORIGIN']) delete env[key];
const evidence = resolve(process.argv[3] ?? 'apps/desktop/release/evidence');
await mkdir(evidence, { recursive: true });
const app = await _electron.launch({ executablePath: windows ? application : join(application, 'Contents/MacOS/MetaWork'),
  args: [`--user-data-dir=${join(root, 'desktop-profile')}`], env, timeout: 120000 });
let serverPid;
let progressTimer;
const setupProgress = [];
try {
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  const page = await app.firstWindow();
  // waitForFunction treats an async predicate's Promise as truthy in this
  // pinned Playwright version. Poll the rendered state, then read IPC once.
  await page.locator('#setup:visible, #retry:visible').waitFor({ timeout: 120000 });
  const initialState = await page.evaluate(() => window.metaworkShell.state());
  assert.equal(initialState.phase, 'setup', initialState.message);
  await page.locator('#setup').waitFor({ state: 'visible' });
  await page.locator('#provider-url').fill(provider.baseUrl);
  await page.locator('#model-id').fill(provider.modelId);
  // Do not place credentials in Playwright's fill-action diagnostic log.
  await page.locator('#api-key').evaluate((input, value) => { input.value = value; }, provider.apiKey);
  const startedAt = Date.now();
  progressTimer = setInterval(() => {
    void page.evaluate(() => window.metaworkShell?.state()).then(state => {
      if (!state || setupProgress.at(-1)?.message === state.message) return;
      // Shell status contains fixed product strings, never provider inputs.
      setupProgress.push({ elapsedMs: Date.now() - startedAt, phase: state.phase, message: state.message });
      console.log(`Packaged setup: ${state.phase}: ${state.message}`);
    }).catch(() => undefined);
  }, 5000);
  await page.locator('#setup button[type=submit]').click();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/, { timeout: 600000 });
  clearInterval(progressTimer);
  await writeFile(join(evidence, 'packaged-setup-progress.json'), JSON.stringify(setupProgress, null, 2));
  await page.locator('.workspace-shell').waitFor({ timeout: 30000 });
  const authenticated = await page.evaluate(async () => (await (await fetch('/api/auth/session')).json()).authenticated);
  assert.equal(authenticated, true);
  await assert.rejects(access(join(installRoot, 'internal/llm-credentials.json')));
  serverPid = JSON.parse(await readFile(join(installRoot, 'server-endpoint.json'), 'utf8')).pid;
  if (realTasks) await runPackagedModelTasks({ page, root, installRoot, evidence });
  await page.reload();
  await page.locator('.workspace-shell').waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(evidence, 'packaged-install.png') });
  await app.close();
  process.kill(serverPid, 0);
  await writeFile(join(evidence, 'packaged-install.json'), JSON.stringify({
    application, authenticated, cleanInstall: true, developerCredentialsAbsent: true,
    restrictedPath: env.PATH, serverSurvivedExit: true, paidTaskExecuted: realTasks,
    platform: process.platform, arch: process.arch, packaged: true,
  }, null, 2));
  console.log('Packaged Desktop clean installation, authenticated Web and Server survival passed.');
} catch (error) {
  const safeMessage = String(error.message).replaceAll(provider.apiKey, '[redacted]');
  const page = await app.firstWindow().catch(() => null);
  if (page?.url().startsWith('file:')) await page.locator('#api-key').evaluate(input => { input.value = ''; }).catch(() => undefined);
  await page?.screenshot({ path: join(evidence, 'packaged-install-failure.png') }).catch(() => undefined);
  const shellState = await page?.evaluate(() => window.metaworkShell?.state()).catch(() => undefined);
  await writeFile(join(evidence, 'packaged-install-failure.json'), JSON.stringify({ message: safeMessage, url: page?.url(), shellState, setupProgress }, null, 2));
  throw new Error(safeMessage);
} finally {
  clearInterval(progressTimer);
  await app.close().catch(() => undefined);
  const node = join(installRoot, 'app/current/desktop-tools/node', windows ? 'node.exe' : 'bin/node');
  const cli = join(installRoot, 'app/current/dist/index.js');
  if (await access(cli).then(() => true, () => false)) {
    await promisify(execFile)(node, [cli, 'server', 'stop'], { env, cwd: installRoot, timeout: 30000 });
  }
}
