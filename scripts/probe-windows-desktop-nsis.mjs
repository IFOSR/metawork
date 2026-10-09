// Installs and removes the current-user Windows candidate in runner temp.
// The smoke uses a disposable data root and proves uninstall does not remove
// account data, while the application itself owns Server drain and cleanup.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Disposable Windows x64 runner required');
}
const [installerArg, evidenceArg] = process.argv.slice(2);
if (!installerArg || !evidenceArg) throw new Error('Installer and evidence paths required');
const installer = resolve(installerArg);
const evidence = resolve(evidenceArg);
await mkdir(evidence, { recursive: true });
await stat(installer);
const exec = promisify(execFile);
const temp = await mkdtemp(join(process.env.RUNNER_TEMP, 'metawork-nsis-'));
const installDir = join(temp, 'MetaWork');
const dataRoot = join(temp, 'account-data');
const env = { ...process.env, METAWORK_DESKTOP_INTERNAL: '1', METAWORK_PACKAGED_SMOKE_ROOT: dataRoot,
  METAWORK_PACKAGED_REAL_TASK: '1', METAWORK_NSIS_ACCEPTANCE: '1' };
const testModel = env.METAWORK_TEST_MODEL;
delete env.METAWORK_TEST_MODEL;
Object.assign(env, { METAWORK_INSTALL_ROOT: join(dataRoot, 'installation'), ANYFUSION_INSTALL_ROOT: join(dataRoot, 'installation'),
  METAWORK_CONFIG_HOME: join(dataRoot, 'config'), ANYFUSION_CONFIG_HOME: join(dataRoot, 'config'),
  METAWORK_SECRET_STORE: 'file', ANYFUSION_SECRET_STORE: 'file', METAWORK_WEB_PORT: '0',
  METAWORK_INTERNAL_LLM_SOURCE_ROOT: join(dataRoot, 'absent-developer-configuration') });
for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;

function assertMissing(path) {
  return access(path).then(() => { throw new Error(`Expected path to be removed: ${path}`); }, error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

await exec(installer, ['/S', `/D=${installDir}`], { cwd: temp, env, windowsHide: true, timeout: 180_000 });
const executable = join(installDir, 'MetaWork.exe');
const uninstaller = join(installDir, 'Uninstall MetaWork.exe');
await Promise.all([stat(executable), stat(uninstaller)]);
await exec(process.execPath, ['apps/desktop/tests/packaged-install-smoke.mjs', executable, evidence], {
  cwd: process.cwd(), env: { ...env, METAWORK_TEST_MODEL: testModel ?? '' }, windowsHide: true, timeout: 2_100_000,
});
const installationData = join(dataRoot, 'installation');
await stat(installationData);
await exec(uninstaller, ['/S'], { cwd: temp, env, windowsHide: true, timeout: 180_000 });
for (let attempt = 0; attempt < 60; attempt += 1) {
  try { await stat(executable); } catch (error) {
    if (error.code === 'ENOENT') break;
    throw error;
  }
  await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
  if (attempt === 59) throw new Error('NSIS uninstall did not remove the application');
}
await assertMissing(executable);
await assertMissing(uninstaller);
await stat(installationData);
// A new NSIS installation must discover the retained account and open its Web
// workspace without asking for model credentials or creating a second account.
await exec(installer, ['/S', `/D=${installDir}`], { cwd: temp, env, windowsHide: true, timeout: 180_000 });
await exec(process.execPath, ['apps/desktop/tests/packaged-install-smoke.mjs', executable, join(evidence, 'reinstall')], {
  cwd: process.cwd(), env: { ...env, METAWORK_PACKAGED_REAL_TASK: '0', METAWORK_PACKAGED_EXPECT_EXISTING: '1' },
  windowsHide: true, timeout: 240_000,
});
const release = await realpath(join(installationData, 'app/current'));
const Database = createRequire(join(release, 'package.json'))('better-sqlite3');
const database = new Database(join(installationData, 'accounts/local-default/data/anyfusion.db'), { readonly: true, fileMustExist: true });
try {
  const tasks = JSON.parse(await readFile(join(evidence, 'real-model-task.json'), 'utf8'));
  assert.equal(database.prepare('SELECT status FROM tasks WHERE id = ?').get(tasks.artifactTaskId)?.status, 'done');
  assert.equal(database.prepare('SELECT status FROM tasks WHERE id = ?').get(tasks.cancelledTaskId)?.status, 'cancelled');
} finally { database.close(); }
await exec(uninstaller, ['/S'], { cwd: temp, env, windowsHide: true, timeout: 180_000 });
for (let attempt = 0; attempt < 60 && await access(executable).then(() => true, () => false); attempt += 1) {
  await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
}
await assertMissing(executable);
await writeFile(join(evidence, 'nsis-install.json'), JSON.stringify({
  passed: true, installer, installedExecutable: executable, currentUserInstall: true,
  cleanInstallSmoke: true, realModelTasks: true, uninstalled: true, accountDataPreserved: true,
  activeUninstallDeclined: true, reinstallReusedAccountAndTasks: true,
}, null, 2));
console.log('Windows NSIS current-user install, packaged smoke, uninstall and data preservation passed.');
