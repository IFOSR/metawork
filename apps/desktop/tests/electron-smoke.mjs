import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron } from 'playwright-core';
import { prepareDevelopmentShell } from '../packaging/development-shell.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(desktop, '../..');
const root = resolve(process.env.METAWORK_DESKTOP_DEVELOPMENT_ROOT ?? join(source, '.tmp/desktop-development'));
const releaseId = JSON.parse(await readFile(join(root, 'app/current/release-identity.json'), 'utf8')).releaseId;
const env = { ...process.env, METAWORK_DESKTOP_DEVELOPMENT_ROOT: root,
  METAWORK_DESKTOP_NODE: process.execPath, METAWORK_DESKTOP_RELEASE: releaseId,
  METAWORK_INSTALL_ROOT: root, ANYFUSION_INSTALL_ROOT: root, METAWORK_WEB_PORT: '0',
  METAWORK_CONFIG_HOME: join(root, 'config-home'), ANYFUSION_CONFIG_HOME: join(root, 'config-home'),
  METACLAW_DISABLE_MARKDOWN_PREVIEW: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = await prepareDevelopmentShell();
const started = performance.now();
const app = await _electron.launch({ executablePath, args: [desktop], env, timeout: 30000 });
const errors = [];
let pid;
let nativeIdentity;
try {
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/u, { timeout: 45000 });
  await page.locator('.workspace-shell').waitFor({ timeout: 15000 });
  if (process.platform === 'darwin') {
    // app.getName()/Menu labels can pass while macOS still shows "Electron".
    // Query AppKit's running application identity, used by the menu bar/Dock.
    const shellPid = app.process().pid;
    const script = `ObjC.import('AppKit');
      const nativeApp = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${shellPid});
      JSON.stringify({ name: ObjC.unwrap(nativeApp.localizedName),
        bundleId: ObjC.unwrap(nativeApp.bundleIdentifier),
        path: ObjC.unwrap(nativeApp.bundleURL.path) });`;
    nativeIdentity = JSON.parse((await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script])).stdout);
    assert.equal(nativeIdentity.name, 'MetaWork');
    assert.equal(nativeIdentity.bundleId, 'com.metawork.desktop.development');
    assert.ok(nativeIdentity.path.endsWith('/MetaWork.app'));
  }
  const readyMs = Math.round(performance.now() - started);
  const manifest = JSON.parse(await readFile(join(root, 'server-endpoint.json'), 'utf8'));
  pid = manifest.pid;
  const facts = await page.evaluate(async () => ({
    bridge: window.metaworkDesktop?.version,
    nodeAbsent: typeof window.require === 'undefined',
    authenticated: (await (await fetch('/api/auth/session')).json()).authenticated,
  }));
  assert.deepEqual(facts, { bridge: 1, nodeAbsent: true, authenticated: true });
  const nativeSavePath = join(root, '原生产物 smoke.txt');
  await app.evaluate(({ BrowserWindow, dialog, shell }, input) => {
    const originalOpen = dialog.showOpenDialog; const originalSave = dialog.showSaveDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.root] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.nativeSavePath });
    const ses = BrowserWindow.getAllWindows()[0].webContents.session;
    const originalFetch = ses.fetch.bind(ses);
    ses.fetch = async (url, options) => {
      if (String(url).endsWith('/api/artifacts/smoke-artifact')) return new Response(JSON.stringify({ artifact: { displayName: '原生产物.txt' } }));
      if (String(url).endsWith('/api/artifacts/smoke-artifact/download')) return new Response('native download fixture');
      return originalFetch(url, options);
    };
    shell.showItemInFolder = () => undefined;
    globalThis.restoreNativeSmoke = () => { dialog.showOpenDialog = originalOpen; dialog.showSaveDialog = originalSave; ses.fetch = originalFetch; };
  }, { root, nativeSavePath });
  assert.equal(await page.evaluate(() => window.metaworkDesktop.selectWorkspaceDirectory()), root);
  const downloadId = await page.evaluate(() => window.metaworkDesktop.saveArtifact('smoke-artifact'));
  assert.equal(await readFile(nativeSavePath, 'utf8'), 'native download fixture');
  await page.evaluate(id => window.metaworkDesktop.showDownloadedArtifact(id), downloadId);
  await app.evaluate(() => globalThis.restoreNativeSmoke());
  await page.evaluate(() => window.metaworkDesktop.setDraft('smoke-conversation', { text: '草稿保留 test', attachments: [] }));
  await page.reload();
  await page.locator('.workspace-shell').waitFor();
  assert.equal(await page.evaluate(async () => (await window.metaworkDesktop.readPreferences()).drafts['smoke-conversation'].text), '草稿保留 test');
  for (const width of [1440, 1100, 900]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: join(root, `desktop-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
  await page.screenshot({ path: join(root, 'desktop-200-percent.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]; win.webContents.setZoomFactor(1); win.setSize(1440, 900);
  });
  await page.waitForFunction(() => !document.querySelector('.workspace-shell[data-sidebar-hidden]'));
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => ['显示', 'View'].includes(item.label)).submenu.items.find(item => ['显示／隐藏侧栏', 'Show/Hide Sidebar'].includes(item.label)).click());
  await page.locator('.workspace-shell[data-sidebar-hidden]').waitFor();
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => ['显示', 'View'].includes(item.label)).submenu.items.find(item => ['搜索对话', 'Search Conversations'].includes(item.label)).click());
  await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
  for (let i = 0; i < 10; i++) await page.evaluate(() => window.metaworkDesktop.reconnect());
  assert.equal(JSON.parse(await readFile(join(root, 'server-endpoint.json'), 'utf8')).pid, pid);
  await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    await new Promise(resolve => { contents.once('did-finish-load', resolve); contents.forcefullyCrashRenderer(); });
  });
  // Playwright retains its crashed-target marker; check the recovered Renderer through Electron.
  await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    if (!contents.getURL().startsWith('file:')) throw new Error('Missing renderer recovery page');
    await new Promise((resolve, reject) => {
      contents.once('did-finish-load', resolve);
      contents.executeJavaScript("document.getElementById('retry').click()").catch(reject);
    });
    if (!contents.getURL().startsWith('http:')) throw new Error('Renderer did not reconnect');
  });
  assert.equal(JSON.parse(await readFile(join(root, 'server-endpoint.json'), 'utf8')).pid, pid);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].hide(); BrowserWindow.getAllWindows()[0].show(); });
  await app.evaluate(async ({ BrowserWindow }) => {
    await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("window.metaworkDesktop.setDraft('smoke-conversation', null)");
  });
  await mkdir(join(root, 'evidence'), { recursive: true });
  await writeFile(join(root, 'evidence/electron-smoke.json'), JSON.stringify({ readyMs, serverPid: pid, facts, nativeIdentity, widths: [1440, 1100, 900],
    zoom: 2, rendererRecovery: true, nativeFilesWithDialogAndHttpFixtures: true, reconnects: 10, errors }, null, 2));
  assert.deepEqual(errors, []);
  process.stdout.write(`Electron production-assets smoke passed; ready=${readyMs}ms; Server PID=${pid}.\n`);
} finally { await app.close(); }
if (pid) { process.kill(pid, 0); process.stdout.write('Server survived Electron exit.\n'); }
