// Installs and removes the current-user Windows candidate in runner temp.
// The smoke uses a disposable data root and proves uninstall does not remove
// account data, while the application itself owns Server drain and cleanup.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
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
  METAWORK_PACKAGED_REAL_TASK: '1' };
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
  cwd: process.cwd(), env, windowsHide: true, timeout: 2_100_000,
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
await writeFile(join(evidence, 'nsis-install.json'), JSON.stringify({
  passed: true, installer, installedExecutable: executable, currentUserInstall: true,
  cleanInstallSmoke: true, realModelTasks: true, uninstalled: true, accountDataPreserved: true,
}, null, 2));
console.log('Windows NSIS current-user install, packaged smoke, uninstall and data preservation passed.');
