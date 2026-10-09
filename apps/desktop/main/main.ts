import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, powerMonitor, screen, session, shell, Tray, type IpcMainInvokeEvent, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveMetaWorkPaths } from '../../../src/installation/paths.js';
import { PRODUCT_ENVIRONMENT, resolveProductEnvironment } from '../../../src/installation/product-environment.js';
import { DesktopServiceManager } from '../../../src/client/desktop-service-manager.js';
import { exchangeDesktopSession } from '../../../src/client/desktop-session-client.js';
import { DesktopPreferenceStore } from './preferences.js';
import { loadWindowsPrivateFiles } from '../../../src/platform/windows-private-files.js';
import { assertMainFrame, businessDocument, externalUrl, identifier, sameOrigin } from './security.js';
import type { DesktopDraft, DesktopMenuAction, ShellState } from '../shared/bridge.js';
import { DesktopNotifications } from './notifications.js';
import { readWindowState, writeWindowState, type WindowState } from './window-state.js';
import { DesktopInstallation } from './installation.js';
import type { DesktopSetupInput } from '../shared/bridge.js';
import { launchDesktopUpdate, pendingDesktopUpdate, prepareDesktopUpdate } from './update.js';
import { installNativeLauncher } from '../../../src/installation/native-launcher.js';
import { authorizeDesktopShellCheck, writeDesktopShellHealth } from '../../../src/installation/desktop-shell-health.js';
import { desktopApplicationRoot } from '../../../src/installation/desktop-platform.js';
import { uninstallReceiptPath, writeUninstallReceipt } from './uninstall.js';

app.setName('MetaWork');
if (process.platform === 'win32') app.setAppUserModelId('com.metawork.desktop');

const here = dirname(fileURLToPath(import.meta.url));
const shellUrl = pathToFileURL(join(here, '..', 'shell', 'index.html')).href;
const developmentRoot = process.env.METAWORK_DESKTOP_DEVELOPMENT_ROOT;
if (!app.isPackaged) {
  if (!developmentRoot || !process.env.METAWORK_DESKTOP_NODE || !process.env.METAWORK_DESKTOP_RELEASE) {
    throw new Error('Use npm run dev:desktop with an isolated installation; direct development access to the normal runtime is disabled.');
  }
  app.setPath('userData', join(resolve(developmentRoot), 'desktop-profile'));
}
let window: BrowserWindow | null = null;
let origin: string | null = null;
let authenticatedInstance: string | null = null;
let webSession: Session;
let manager: DesktopServiceManager;
let installation: DesktopInstallation | null = null;
let installRoot: string;
let selectedConfigHome: string | undefined;
let preferences: DesktopPreferenceStore | null = null;
let state: ShellState = { phase: 'connecting', message: '正在连接后台服务…' };
let quitting = false;
let tray: Tray | undefined;
let connectPromise: Promise<void> | null = null;
const downloads = new Map<string, string>();
let saving = false;
let updating = false;
let queuedInstaller: string | undefined;
let queuedUninstall: string[] | undefined;
let notifications: DesktopNotifications;
let notificationTimer: ReturnType<typeof setInterval> | undefined;
let windowState: WindowState;
const visibleNotifications = new Set<Notification>();
const shellCheckChallenge = app.isPackaged
  ? process.argv.find(value => value.startsWith('--metawork-update-check='))?.split('=')[1] : undefined;

function menuLabels(): {
  application: string;
  about: string;
  settings: string;
  reconnect: string;
  stopService: string;
  installUpdate: string;
  repairUpdate: string;
  selectInstallation: string;
  installCommand: string;
  logout: string;
  quit: string;
  file: string;
  newConversation: string;
  hideWindow: string;
  edit: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
  view: string;
  search: string;
  sidebar: string;
  resetZoom: string;
  zoomIn: string;
  zoomOut: string;
  fullscreen: string;
  window: string;
  minimize: string;
  close: string;
} {
  const chinese = /^zh(?:-|$)/iu.test(app.getLocale());
  return chinese ? {
    application: 'MetaWork', about: '关于 MetaWork', settings: '设置…', reconnect: '重新连接后台',
    stopService: '停止后台服务…', installUpdate: '安装新版应用…', repairUpdate: '修复未完成的更新…',
    selectInstallation: '选择已有安装…', installCommand: '安装终端命令…', logout: '退出本地会话并清理草稿',
    quit: '退出桌面（后台继续运行）', file: '文件', newConversation: '新建对话', hideWindow: '隐藏窗口',
    edit: '编辑', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
    view: '显示', search: '搜索对话', sidebar: '显示／隐藏侧栏', resetZoom: '重置缩放', zoomIn: '放大',
    zoomOut: '缩小', fullscreen: '全屏', window: '窗口', minimize: '最小化', close: '关闭',
  } : {
    application: 'MetaWork', about: 'About MetaWork', settings: 'Settings…', reconnect: 'Reconnect to Server',
    stopService: 'Stop Server…', installUpdate: 'Install Update…', repairUpdate: 'Repair Interrupted Update…',
    selectInstallation: 'Choose Existing Installation…', installCommand: 'Install Terminal Command…',
    logout: 'Sign Out and Clear Drafts', quit: 'Quit MetaWork (Server Continues)', file: 'File',
    newConversation: 'New Conversation', hideWindow: 'Hide Window', edit: 'Edit', undo: 'Undo', redo: 'Redo',
    cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All', view: 'View', search: 'Search Conversations',
    sidebar: 'Show/Hide Sidebar', resetZoom: 'Reset Zoom', zoomIn: 'Zoom In', zoomOut: 'Zoom Out',
    fullscreen: 'Toggle Full Screen', window: 'Window', minimize: 'Minimize', close: 'Close',
  };
}

function owned(event: IpcMainInvokeEvent): void {
  if (!window || window.isDestroyed()) throw new Error('Window is unavailable');
  assertMainFrame({
    senderId: event.sender.id, ownerId: window.webContents.id,
    mainFrame: event.senderFrame === window.webContents.mainFrame,
    url: event.senderFrame?.url ?? '', origin,
  });
}
function ownedShell(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || event.senderFrame.url !== shellUrl) throw new Error('Shell capability denied');
}
function showWindow(): void {
  if (process.platform === 'win32' && window?.isMinimized()) window.restore();
  window?.show(); window?.focus();
}
function setState(next: ShellState): void {
  state = next;
  if (window?.webContents.getURL() === shellUrl) window.webContents.send('shell:state', state);
}
function connect(): Promise<void> {
  connectPromise ??= connectOnce().finally(() => { connectPromise = null; });
  return connectPromise;
}
async function connectOnce(): Promise<void> {
  const win = window;
  if (!win) return;
  setState({ phase: 'connecting', message: '正在确认安装和后台服务…' });
  try {
    if (installation) {
      const release = await installation.verify();
      const windows = process.platform === 'win32' ? { root: installRoot,
        files: loadWindowsPrivateFiles(join(installation.resources, 'payload/metawork/native/windows/metawork-platform.node')) } : undefined;
      if (await pendingDesktopUpdate(installRoot, windows)
        && !(shellCheckChallenge && await authorizeDesktopShellCheck(installRoot, {
          challenge: shellCheckChallenge, applicationPath: await realpath(desktopApplicationRoot(process.resourcesPath)), releaseId: release.releaseId,
        }, windows))) throw new Error('Desktop update requires recovery');
      if (!await installation.installed()) {
        setState({ phase: 'setup', message: '运行环境已就绪。添加模型连接后即可开始工作。' });
        return;
      }
      manager = new DesktopServiceManager({ installRoot, releaseId: release.releaseId, nodePath: await installation.nodePath(),
        configHome: selectedConfigHome });
    }
    const grant = await manager.connect();
    await exchangeDesktopSession(grant, webSession.fetch.bind(webSession) as typeof fetch, authenticatedInstance === grant.instanceId);
    authenticatedInstance = grant.instanceId;
    const store = new DesktopPreferenceStore(join(app.getPath('userData'), 'preferences', grant.installationId, `${grant.accountId}.json`),
      process.platform === 'win32' ? loadWindowsPrivateFiles(installation
        ? join(installation.resources, 'payload/metawork/native/windows/metawork-platform.node')
        : join(installRoot, 'app/current/native/windows/metawork-platform.node')) : undefined);
    await preferences?.flush();
    await store.load();
    preferences = store;
    origin = !app.isPackaged && process.env.METAWORK_DESKTOP_UI_ORIGIN ? process.env.METAWORK_DESKTOP_UI_ORIGIN : grant.webOrigin;
    if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)) throw new Error('Invalid UI origin');
    notifications.attach(grant.webOrigin);
    if (!win.isDestroyed() && !sameOrigin(win.webContents.getURL(), origin)) await win.loadURL(origin);
    if (shellCheckChallenge) {
      const deadline = Date.now() + 30_000;
      while (!await win.webContents.executeJavaScript('Boolean(document.querySelector(".workspace-shell"))')) {
        if (Date.now() >= deadline) throw new Error('Desktop Web did not render');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await writeDesktopShellHealth(installRoot, { challenge: shellCheckChallenge, releaseId: grant.releaseId,
        instanceId: grant.instanceId, pid: process.pid }, process.platform === 'win32' ? { root: installRoot,
        files: loadWindowsPrivateFiles(join(installRoot, 'app/current/native/windows/metawork-platform.node')) } : undefined);
    }
    setState({ phase: 'ready', message: '后台服务已连接' });
  } catch (error) {
    // Never interpolate provider response bodies or native command output into diagnostics.
    origin = null;
    setState({ phase: 'error', message: error instanceof Error && /update requires recovery/u.test(error.message)
      ? '配套更新尚未完成。请使用 MetaWork 菜单中的“修复未完成的更新”。'
      : error instanceof Error && /mismatch/u.test(error.message)
      ? '已安装版本与桌面版本不匹配。请先完成配套升级，再重新连接。'
      : '后台服务尚未就绪。请确认配套运行时已安装，或查看安装目录中的服务日志。' });
    if (!win.isDestroyed()) await win.loadURL(shellUrl);
  }
}

ipcMain.handle('shell:state', event => { ownedShell(event); return state; });
ipcMain.handle('shell:retry', event => { ownedShell(event); return connect(); });
ipcMain.handle('shell:setup', async (event, input: DesktopSetupInput) => {
  ownedShell(event);
  if (!installation || state.phase !== 'setup' || !input || typeof input !== 'object'
    || Object.keys(input).some(key => !['baseUrl', 'apiKey', 'modelId'].includes(key))
    || typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048
    || typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 8192
    || typeof input.modelId !== 'string' || !input.modelId.trim() || input.modelId.length > 256) throw new Error('Invalid setup');
  const providerUrl = new URL(input.baseUrl);
  if (!['http:', 'https:'].includes(providerUrl.protocol) || providerUrl.username || providerUrl.password) throw new Error('Invalid provider URL');
  setState({ phase: 'connecting', message: '正在安装运行时并保存模型配置…' });
  try {
    await installation.run('install', input, phase => setState({ phase: 'connecting', message: {
      verifying: '正在验证安装文件…',
      'staging-release': '正在复制运行环境，首次安装可能需要几分钟…',
      configuring: '正在保存模型配置并初始化数据…',
      activating: '正在启用已安装的运行环境…',
    }[phase] }));
    await connect();
  }
  catch { setState({ phase: 'setup', message: '安装未完成，输入内容已保留。请检查磁盘空间和模型配置后重试。' }); }
});
ipcMain.handle('desktop:preferences', event => { owned(event); return preferences!.read(); });
ipcMain.handle('desktop:theme', (event, theme: unknown) => { owned(event); return preferences!.setTheme(theme); });
ipcMain.handle('desktop:draft', (event, id: unknown, draft: DesktopDraft | null) => { owned(event); return preferences!.setDraft(id, draft); });
ipcMain.handle('desktop:clear-drafts', event => { owned(event); return preferences!.clearDrafts(); });
ipcMain.handle('desktop:viewport', (event, id, value) => { owned(event); return preferences!.setViewport(id, value); });
ipcMain.handle('desktop:route', (event, route) => { owned(event); return preferences!.setRoute(route); });
ipcMain.handle('desktop:reconnect', event => { owned(event); return connect(); });
ipcMain.handle('desktop:select-workspace', async event => {
  owned(event);
  const result = await dialog.showOpenDialog(window!, { title: '选择工作区', properties: ['openDirectory', 'createDirectory'] });
  owned(event);
  return result.canceled ? null : result.filePaths[0] ?? null;
});
ipcMain.handle('desktop:save-artifact', async (event, id: unknown) => {
  owned(event);
  if (!identifier(id) || saving) throw new Error('下载请求不可用');
  saving = true;
  let temporary: string | null = null;
  const downloadOrigin = origin;
  try {
    const url = `${origin}/api/artifacts/${encodeURIComponent(id)}`;
    const metaResponse = await webSession.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!metaResponse.ok) throw new Error('产物不可用');
    const body = await metaResponse.json() as { artifact?: { displayName?: string } };
    const metadata = body.artifact ?? {};
    const name = typeof metadata.displayName === 'string'
      ? metadata.displayName.replace(/[\\/\x00-\x1f]/gu, '_').slice(0, 200) : 'artifact';
    owned(event);
    const result = await dialog.showSaveDialog(window!, { title: '保存产物', defaultPath: name });
    if (result.canceled || !result.filePath) return null;
    owned(event);
    const response = await webSession.fetch(`${url}/download`, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error('产物下载失败');
    temporary = join(dirname(result.filePath), `.metawork-download-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    const reader = response.body.getReader();
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 512 * 1024 * 1024) throw new Error('文件超过桌面下载上限');
        await file.writeFile(chunk.value);
      }
      await file.sync();
    } finally { await reader.cancel().catch(() => undefined); await file.close(); }
    owned(event);
    if (origin !== downloadOrigin) throw new Error('下载会话已变更');
    await rename(temporary, result.filePath);
    temporary = null;
    const downloadId = randomUUID();
    downloads.set(downloadId, result.filePath);
    if (downloads.size > 64) downloads.delete(downloads.keys().next().value!);
    return downloadId;
  } finally {
    saving = false;
    if (temporary) await rm(temporary, { force: true });
  }
});
ipcMain.handle('desktop:reveal-artifact', (event, id: unknown) => {
  owned(event);
  if (typeof id !== 'string' || !downloads.has(id)) throw new Error('下载记录不可用');
  shell.showItemInFolder(downloads.get(id)!);
});

function menuAction(action: DesktopMenuAction): void {
  showWindow();
  if (window && sameOrigin(window.webContents.getURL(), origin)) window.webContents.send('desktop:menu', action);
}
async function stopService(): Promise<void> {
  if (!window || !origin) return;
  let detail: string;
  try {
    const response = await webSession.fetch(`${origin}/api/client/service-activity`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Activity unavailable');
    const activity = await response.json() as { activeTasks: number; tasks: Array<{ title: string }>; truncated: boolean };
    detail = `当前有 ${activity.activeTasks} 个未结束任务。\n${activity.tasks.slice(0, 20).map(task => task.title).join('\n')}`
      + `${activity.truncated ? '\n…' : ''}\n\nWeb、TUI、飞书和桌面将同时断开。关闭桌面窗口可继续后台工作。`;
  } catch {
    dialog.showErrorBox('暂时无法读取后台状态', '请等待连接恢复后重试停止操作。'); return;
  }
  const answer = await dialog.showMessageBox(window, {
    type: 'warning', title: '停止后台服务', message: '停止服务会影响所有客户端和正在进行的工作。',
    detail,
    buttons: ['继续运行', '停止后台服务'], defaultId: 0, cancelId: 0,
  });
  if (answer.response !== 1) return;
  try {
    await manager.stop();
    notifications.stop();
    origin = null;
    setState({ phase: 'error', message: '后台服务已停止。点击重新连接可再次启动。' });
    await window.loadURL(shellUrl);
  } catch { dialog.showErrorBox('服务尚未停止', '请检查后台状态。任务状态以 Server 中的记录为准。'); }
}

async function updateApplication(recover = false, installerPath?: string): Promise<void> {
  if (!app.isPackaged || !window || !installation || updating) return;
  updating = true;
  try {
    if (!recover) {
      const selected = installerPath ? { canceled: false, filePaths: [installerPath] }
        : await dialog.showOpenDialog(window, { title: process.platform === 'win32' ? '选择新版 MetaWork 安装包' : '选择新版 MetaWork.app',
          properties: ['openFile'], filters: [{ name: 'MetaWork 应用', extensions: [process.platform === 'win32' ? 'exe' : 'app'] }] });
      if (selected.canceled || !selected.filePaths[0]) return;
      setState({ phase: 'connecting', message: '正在验证新版应用和配套运行时…' });
      await prepareDesktopUpdate({ root: installRoot, applicationPath: desktopApplicationRoot(process.resourcesPath),
        candidatePath: selected.filePaths[0], resources: process.resourcesPath,
        configHome: selectedConfigHome, userDataPath: app.getPath('userData') });
    }
    let taskSummary = '后台状态暂不可读；安装器会在正式停止完成后才切换版本。';
    if (origin) {
      const response = await webSession.fetch(`${origin}/api/client/service-activity`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Service activity is unavailable');
      const activity = await response.json() as { activeTasks: number };
      taskSummary = `当前有 ${activity.activeTasks} 个未结束任务。升级会执行全局停止流程，所有客户端会暂时断开。`;
    }
    const answer = await dialog.showMessageBox(window, { type: 'warning',
      message: recover ? '修复上次未完成的更新？' : '安装已验证的新版应用？',
      detail: `${taskSummary}\n桌面将退出，由独立安装器完成切换。回滚可能恢复到升级前的数据时间点。`,
      buttons: ['取消', recover ? '退出并修复' : '退出并更新'], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) return;
    await preferences?.flush();
    notifications.stop();
    await launchDesktopUpdate(installRoot);
    app.quit();
  } catch {
    dialog.showErrorBox('更新尚未完成', '请确认新版应用签名、配套版本、磁盘空间和应用目录写入权限。已有数据与更新记录会保留；可使用“修复未完成的更新”重试。');
  } finally { updating = false; }
}

function receiveInstaller(args: string[]): void {
  if (!app.isPackaged || process.platform !== 'win32') return;
  const candidate = args.find(value => value.startsWith('--metawork-install-update='))?.slice('--metawork-install-update='.length);
  if (!candidate || candidate.length > 4096 || !isAbsolute(candidate) || !candidate.toLowerCase().endsWith('.exe')) return;
  if (!installation || !window) { queuedInstaller = candidate; return; }
  showWindow(); void updateApplication(false, candidate);
}

async function receiveUninstaller(args: string[]): Promise<void> {
  if (!app.isPackaged || process.platform !== 'win32') return;
  const path = args.find(value => value.startsWith('--metawork-uninstall='))?.slice('--metawork-uninstall='.length);
  if (!path) return;
  if (!installation || !window) { queuedUninstall = args; return; }
  let receipt: string;
  try { receipt = await uninstallReceiptPath(path); } catch { return; }
  if (updating) { await writeUninstallReceipt(receipt, false).catch(() => undefined); return; }
  updating = true;
  let approved = false;
  try {
    const installed = await installation.installed();
    let activeTasks = 0;
    if (installed) {
      if (!origin) throw new Error('Service activity is unavailable');
      const response = await webSession.fetch(`${origin}/api/client/service-activity`, {
        redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Service activity is unavailable');
      const activity = await response.json() as { activeTasks: number };
      if (!Number.isSafeInteger(activity.activeTasks) || activity.activeTasks < 0) throw new Error('Invalid service activity');
      activeTasks = activity.activeTasks;
    }
    if (activeTasks > 0 || !args.includes('--metawork-uninstall-silent')) {
      showWindow();
      const answer = await dialog.showMessageBox(window, { type: 'warning', title: '卸载 MetaWork',
        message: activeTasks > 0 ? `当前有 ${activeTasks} 个未结束任务，仍要停止服务并卸载？` : '停止后台服务并卸载桌面应用？',
        detail: 'Web、TUI、飞书和桌面将同时断开。配置、对话和工作成果会保留，可在重新安装后继续使用。',
        buttons: ['继续运行', '停止服务并卸载'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return;
    }
    if (installed) await manager.stop();
    await preferences?.flush();
    notifications.stop();
    approved = true;
  } catch {
    dialog.showErrorBox('尚未卸载', '无法确认后台状态或完成正式停止。应用和数据已保留，请检查服务状态后重试。');
  } finally {
    try { await writeUninstallReceipt(receipt, approved); }
    catch { approved = false; }
    updating = false;
    if (approved) app.quit();
  }
}

async function logoutDesktop(): Promise<void> {
  const currentOrigin = origin;
  origin = null; notifications.stop();
  authenticatedInstance = null;
  await preferences?.clearDrafts();
  if (currentOrigin) await webSession.fetch(`${currentOrigin}/api/auth/logout`, {
    method: 'POST', headers: { Origin: currentOrigin }, signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
  await webSession.clearStorageData();
  downloads.clear(); preferences = null;
  setState({ phase: 'error', message: '已退出本地会话并清理草稿。点击重新连接可继续使用。' });
  await window?.loadURL(shellUrl);
}

async function selectInstallation(): Promise<void> {
  if (!app.isPackaged || !window) return;
  const selected = await dialog.showOpenDialog(window, { title: '选择已有 MetaWork 安装目录', properties: ['openDirectory', 'showHiddenFiles'] });
  if (selected.canceled || !selected.filePaths[0]) return;
  const root = resolve(selected.filePaths[0]);
  try {
    await access(join(root, 'app/current/release-identity.json'));
    const config = await dialog.showOpenDialog(window, { title: '选择配置目录（取消则使用默认配置目录）', properties: ['openDirectory', 'showHiddenFiles'] });
    const configHome = config.canceled ? undefined : config.filePaths[0];
    await preferences?.flush();
    notifications.stop(); origin = null; authenticatedInstance = null; preferences = null; downloads.clear();
    await webSession.clearStorageData();
    const path = join(app.getPath('userData'), 'installation.json');
    await writeFile(`${path}.tmp`, JSON.stringify({ root, configHome }), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    installRoot = root; selectedConfigHome = configHome;
    installation = new DesktopInstallation(process.resourcesPath, root, app.getVersion());
    await window.loadURL(shellUrl); await connect();
  } catch { dialog.showErrorBox('无法使用该安装', '请选择包含 app/current 的 MetaWork 安装目录。原安装的数据不会被迁移或合并。'); }
}

async function installTerminalCommand(): Promise<void> {
  if (!window || !app.isPackaged) return;
  const paths = resolveMetaWorkPaths(undefined, installRoot);
  const choice = await dialog.showMessageBox(window, { message: '安装 metawork 终端命令？',
    detail: `将在 ${paths.launcher} 创建正式启动器。不会修改 shell 配置或覆盖其他程序。`,
    buttons: ['取消', '安装'], defaultId: 1, cancelId: 0 });
  if (choice.response !== 1) return;
  try {
    await installNativeLauncher(paths.launcher, installRoot);
    await dialog.showMessageBox(window, { message: '终端命令已安装', detail: `可运行 ${paths.launcher}。若命令未加入 PATH，可使用这个完整路径。` });
  } catch { dialog.showErrorBox('终端命令未安装', '目标位置可能已有其他安装的命令，或当前用户没有写入权限。'); }
}

async function start(): Promise<void> {
  await app.whenReady();
  webSession = session.fromPartition('metawork-desktop-session');
  webSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  webSession.setPermissionCheckHandler(() => false);
  webSession.on('will-download', event => event.preventDefault());
  notifications = new DesktopNotifications({
    fetch: webSession.fetch.bind(webSession) as typeof fetch,
    unavailable: () => { /* Web's connection indicator and explicit reconnect retain the draft. */ },
    show: event => {
      if (!Notification.isSupported()) return;
      const notice = new Notification({ title: 'MetaWork', body: event.kind === 'approval'
        ? '有一项工作需要你审批。' : event.kind === 'failed' ? '有一项工作未能完成。' : '有一项工作已完成。' });
      notice.on('click', () => {
        showWindow();
        if (!window || !origin) return;
        const params = new URLSearchParams({ workspace: event.workspaceId, conversation: event.conversationId, task: event.taskId });
        if (event.turnId) params.set('turn', event.turnId);
        // Only same-document navigation; existing Web authorization resolves the target.
        void window.loadURL(`${origin}/#${params}`);
      });
      notice.on('close', () => visibleNotifications.delete(notice));
      visibleNotifications.add(notice);
      if (visibleNotifications.size > 16) { const oldest = visibleNotifications.values().next().value!; oldest.close(); visibleNotifications.delete(oldest); }
      notice.show();
    },
  });
  notificationTimer = setInterval(() => { void notifications.poll(); }, 3000);
  let installationSelection: { root?: string; configHome?: string } = {};
  if (app.isPackaged) {
    const saved = await readFile(join(app.getPath('userData'), 'installation.json'), 'utf8').catch(() => null);
    if (saved) {
      const value = JSON.parse(saved);
      if (typeof value.root === 'string' && isAbsolute(value.root)
        && (value.configHome === undefined || typeof value.configHome === 'string' && isAbsolute(value.configHome))) installationSelection = value;
    }
  }
  const explicitInstallRoot = resolveProductEnvironment(process.env, ...PRODUCT_ENVIRONMENT.installRoot);
  const paths = resolveMetaWorkPaths(undefined, developmentRoot ?? explicitInstallRoot ?? installationSelection.root);
  installRoot = paths.root;
  selectedConfigHome = resolveProductEnvironment(process.env, ...PRODUCT_ENVIRONMENT.configHome) ?? installationSelection.configHome;
  if (app.isPackaged) installation = new DesktopInstallation(process.resourcesPath, installRoot, app.getVersion());
  else manager = new DesktopServiceManager({
    installRoot, releaseId: process.env.METAWORK_DESKTOP_RELEASE!, nodePath: process.env.METAWORK_DESKTOP_NODE!,
    configHome: selectedConfigHome });
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
  windowState = await readWindowState(join(app.getPath('userData'), 'window.json'), screen.getAllDisplays().map(d => d.workArea));
  window = new BrowserWindow({
    title: 'MetaWork', ...windowState.bounds, minWidth: 800, minHeight: 600,
    show: false, backgroundColor: '#f5f4ef',
    webPreferences: { preload: join(here, 'preload.cjs'), session: webSession,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
  });
  if (windowState.maximized) window.maximize();
  window.once('ready-to-show', showWindow);
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (!windowState.closeExplained) {
      windowState.closeExplained = true;
      void dialog.showMessageBox(window!, { message: '关闭窗口后，后台工作会继续。',
        detail: process.platform === 'win32'
          ? '点击系统托盘中的 MetaWork 图标，或再次启动 MetaWork，可以恢复窗口。停止后台服务请使用 MetaWork 菜单。'
          : '点击 Dock 图标可以重新打开。停止后台服务请使用 MetaWork 菜单。', buttons: ['知道了'] }).then(() => window?.hide());
    } else window?.hide();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const safe = externalUrl(url);
    if (safe) void shell.openExternal(safe);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url === shellUrl || businessDocument(url, origin)) return;
    event.preventDefault();
    if (sameOrigin(url, origin)) return;
    const safe = externalUrl(url);
    if (safe) void shell.openExternal(safe);
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!businessDocument(url, origin)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => {
    origin = null;
    setState({ phase: 'error', message: '窗口需要重新加载，后台任务继续运行。' });
    void window?.loadURL(shellUrl);
  });
  const labels = menuLabels();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: labels.application, submenu: [
      { role: 'about', label: labels.about },
      { label: labels.settings, accelerator: 'CmdOrCtrl+,', click: () => menuAction('settings') },
      { type: 'separator' }, { label: labels.reconnect, click: () => { void connect(); } },
      { label: labels.stopService, click: () => { void stopService(); } },
      { label: labels.installUpdate, enabled: app.isPackaged, click: () => { void updateApplication(); } },
      { label: labels.repairUpdate, enabled: app.isPackaged, click: () => { void updateApplication(true); } },
      { label: labels.selectInstallation, enabled: app.isPackaged, click: () => { void selectInstallation(); } },
      { label: labels.installCommand, enabled: app.isPackaged, click: () => { void installTerminalCommand(); } },
      { label: labels.logout, click: () => { void logoutDesktop(); } },
      { type: 'separator' }, process.platform === 'win32'
        ? { label: labels.hideWindow, click: () => window?.hide() }
        : { role: 'hide', label: labels.hideWindow },
      { label: labels.quit, accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ] },
    { label: labels.file, submenu: [
      { label: labels.newConversation, accelerator: 'CmdOrCtrl+N', click: () => menuAction('new-conversation') },
      { label: labels.hideWindow, accelerator: 'CmdOrCtrl+W', click: () => window?.hide() },
    ] },
    { label: labels.edit, submenu: [
      { role: 'undo', label: labels.undo }, { role: 'redo', label: labels.redo }, { type: 'separator' },
      { role: 'cut', label: labels.cut }, { role: 'copy', label: labels.copy },
      { role: 'paste', label: labels.paste }, { role: 'selectAll', label: labels.selectAll },
    ] },
    { label: labels.view, submenu: [
      { label: labels.search, accelerator: 'CmdOrCtrl+K', click: () => menuAction('search') },
      { label: labels.sidebar, accelerator: 'CmdOrCtrl+B', click: () => menuAction('toggle-sidebar') },
      { role: 'resetZoom', label: labels.resetZoom }, { role: 'zoomIn', label: labels.zoomIn },
      { role: 'zoomOut', label: labels.zoomOut }, { role: 'togglefullscreen', label: labels.fullscreen },
    ] },
    { label: labels.window, submenu: [
      { role: 'minimize', label: labels.minimize }, { role: 'close', label: labels.close },
    ] },
  ]));
  if (process.platform === 'win32') {
    const icon = await app.getFileIcon(process.execPath, { size: 'small' });
    if (icon.isEmpty()) throw new Error('Windows application icon is unavailable');
    tray = new Tray(icon);
    tray.setToolTip('MetaWork');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: app.getLocale().startsWith('zh') ? '打开 MetaWork' : 'Open MetaWork', click: showWindow },
      { label: labels.settings, click: () => menuAction('settings') },
      { type: 'separator' },
      { label: labels.stopService, click: () => { showWindow(); void stopService(); } },
      { label: labels.quit, click: () => app.quit() },
    ]));
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  }
  powerMonitor.on('resume', () => { void connect(); });
  await window.loadURL(shellUrl);
  await connect();
  receiveInstaller(queuedInstaller ? [`--metawork-install-update=${queuedInstaller}`] : process.argv);
  queuedInstaller = undefined;
  await receiveUninstaller(queuedUninstall ?? process.argv);
  queuedUninstall = undefined;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, args) => { showWindow(); receiveInstaller(args); void receiveUninstaller(args); });
  app.on('activate', showWindow);
  app.on('window-all-closed', () => undefined);
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (notificationTimer) clearInterval(notificationTimer);
    notifications?.stop();
    const saveWindow = window && !window.isDestroyed() && windowState
      ? writeWindowState(join(app.getPath('userData'), 'window.json'), { ...windowState,
        bounds: window.getNormalBounds(), maximized: window.isMaximized() }) : Promise.resolve();
    void Promise.allSettled([preferences?.flush(), saveWindow]).finally(() => { quitting = true; tray?.destroy(); app.quit(); });
  });
  void start().catch(() => { dialog.showErrorBox('MetaWork 无法启动', '桌面安装不完整，请重新安装配套版本。'); app.quit(); });
}
