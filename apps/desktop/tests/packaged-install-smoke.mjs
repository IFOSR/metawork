import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { _electron } from 'playwright-core';

// Clean-install smoke of the signed app; no model requests or paid task execution.
const application = resolve(process.argv[2] ?? '');
const windows = process.platform === 'win32';
if (windows ? basename(application) !== 'MetaWork.exe' : !application.endsWith('/MetaWork.app')) {
  throw new Error('Supply the packaged MetaWork application path');
}
const root = await mkdtemp(join(tmpdir(), 'metawork-packaged-install-'));
const installRoot = join(root, 'installation');
const env = { ...process.env,
  METAWORK_INSTALL_ROOT: installRoot, ANYFUSION_INSTALL_ROOT: installRoot,
  METAWORK_CONFIG_HOME: join(root, 'config'), ANYFUSION_CONFIG_HOME: join(root, 'config'),
  METAWORK_SECRET_STORE: 'file', ANYFUSION_SECRET_STORE: 'file',
  METAWORK_WEB_PORT: '0', METACLAW_DISABLE_MARKDOWN_PREVIEW: '1',
  METAWORK_INTERNAL_LLM_SOURCE_ROOT: join(root, 'absent-developer-configuration') };
for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
env.PATH = windows ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` : '/usr/bin:/bin';
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE',
  'METAWORK_DESKTOP_DEVELOPMENT_ROOT', 'METAWORK_DESKTOP_DEVELOPMENT', 'METAWORK_DESKTOP_UI_ORIGIN']) delete env[key];
const evidence = resolve(process.argv[3] ?? 'apps/desktop/release/evidence');
await mkdir(evidence, { recursive: true });
const app = await _electron.launch({ executablePath: windows ? application : join(application, 'Contents/MacOS/MetaWork'),
  args: [`--user-data-dir=${join(root, 'desktop-profile')}`], env, timeout: 120000 });
let serverPid;
try {
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  const page = await app.firstWindow();
  await page.locator('#setup').waitFor({ state: 'visible', timeout: 120000 });
  await page.locator('#provider-url').fill('https://provider.example.invalid/v1');
  await page.locator('#model-id').fill('deepseek-chat');
  await page.locator('#api-key').fill('packaged-install-fixture');
  await page.locator('#setup button[type=submit]').click();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/, { timeout: 180000 });
  await page.locator('.workspace-shell').waitFor({ timeout: 30000 });
  const authenticated = await page.evaluate(async () => (await (await fetch('/api/auth/session')).json()).authenticated);
  assert.equal(authenticated, true);
  await assert.rejects(access(join(installRoot, 'internal/llm-credentials.json')));
  serverPid = JSON.parse(await readFile(join(installRoot, 'server-endpoint.json'), 'utf8')).pid;
  await page.reload();
  await page.locator('.workspace-shell').waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(evidence, 'packaged-install.png') });
  await app.close();
  process.kill(serverPid, 0);
  await writeFile(join(evidence, 'packaged-install.json'), JSON.stringify({
    application, authenticated, cleanInstall: true, developerCredentialsAbsent: true,
    restrictedPath: env.PATH, serverSurvivedExit: true, paidTaskExecuted: false,
    platform: process.platform, arch: process.arch, packaged: true,
  }, null, 2));
  console.log('Packaged Desktop clean installation, authenticated Web and Server survival passed.');
} catch (error) {
  const page = await app.firstWindow().catch(() => null);
  await page?.screenshot({ path: join(evidence, 'packaged-install-failure.png') }).catch(() => undefined);
  await writeFile(join(evidence, 'packaged-install-failure.json'), JSON.stringify({ message: error.message, url: page?.url() }, null, 2));
  throw error;
} finally {
  await app.close().catch(() => undefined);
  const node = join(installRoot, 'app/current/desktop-tools/node', windows ? 'node.exe' : 'bin/node');
  const cli = join(installRoot, 'app/current/dist/index.js');
  if (await access(cli).then(() => true, () => false)) {
    await promisify(execFile)(node, [cli, 'server', 'stop'], { env, cwd: installRoot, timeout: 30000 });
  }
}
