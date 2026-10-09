// Runs in the disposable Windows 11 ordinary user's interactive session.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const evidence = resolve(process.argv[2]);
await mkdir(evidence, { recursive: true });
const exec = promisify(execFile);
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const identityScript = "$o=Get-CimInstance Win32_OperatingSystem;$p=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent());@{os=$o.Caption;productType=$o.ProductType;elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);interactive=[Environment]::UserInteractive}|ConvertTo-Json -Compress";
const identity = JSON.parse((await exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(identityScript, 'utf16le').toString('base64')], { timeout: 30000 })).stdout);
assert.match(identity.os, /Windows 11/u);
assert.equal(identity.productType, 1);
assert.equal(identity.elevated, false);
assert.equal(identity.interactive, true);
const kit = JSON.parse(await readFile('acceptance-kit.json', 'utf8'));
assert.equal(kit.sourceCommit, process.env.GITHUB_SHA);
assert.equal(kit.installer, 'MetaWork-win32-x64-setup.exe');
const installer = resolve(kit.installer);
assert.equal(createHash('sha256').update(await readFile(installer)).digest('hex'), kit.installerSha256);
const root = await mkdtemp(join(process.env.TEMP, 'metawork-win11-'));
const installation = join(root, '中文 desktop');
const account = join(root, 'account');
const executable = join(installation, 'MetaWork.exe');
const uninstaller = join(installation, 'Uninstall MetaWork.exe');
const env = { ...process.env, RUNNER_TEMP: root, METAWORK_DESKTOP_INTERNAL: '1',
  METAWORK_PACKAGED_SMOKE_ROOT: account, METAWORK_NSIS_ACCEPTANCE: '1',
  METAWORK_INSTALL_ROOT: join(account, 'installation'), ANYFUSION_INSTALL_ROOT: join(account, 'installation'),
  METAWORK_CONFIG_HOME: join(account, 'config'), ANYFUSION_CONFIG_HOME: join(account, 'config'),
  METAWORK_WEB_PORT: '0', METAWORK_SECRET_STORE: 'file', ANYFUSION_SECRET_STORE: 'file' };
const model = env.METAWORK_TEST_MODEL;
delete env.METAWORK_TEST_MODEL;
delete process.env.METAWORK_TEST_MODEL;
const report = { scope: 'windows11-desktop-product', passed: false, ...identity,
  sourceCommit: kit.sourceCommit, releaseId: kit.releaseId, installerSha256: kit.installerSha256 };
async function uninstall() {
  await exec(uninstaller, ['/S'], { env, timeout: 180000 });
  const deadline = Date.now() + 30000;
  while (await access(executable).then(() => true, () => false)) {
    if (Date.now() >= deadline) throw new Error('Windows 11 uninstall did not remove the shell');
    await new Promise(done => setTimeout(done, 500));
  }
  await access(join(account, 'installation/accounts/local-default/data/anyfusion.db'));
}
try {
  await exec(installer, ['/S', `/D=${installation}`], { env, timeout: 180000 });
  await exec(process.execPath, ['apps/desktop/tests/packaged-install-smoke.mjs', executable, evidence], {
    env: { ...env, METAWORK_PACKAGED_REAL_TASK: '1', METAWORK_TEST_MODEL: model }, timeout: 2100000,
  });
  for (const name of ['real-model-task', 'ordinary-browser', 'native-terminal']) {
    assert.equal(JSON.parse(await readFile(join(evidence, `${name}.json`), 'utf8')).passed, true);
  }
  await uninstall();
  await exec(installer, ['/S', `/D=${installation}`], { env, timeout: 180000 });
  await exec(process.execPath, ['apps/desktop/tests/packaged-install-smoke.mjs', executable, join(evidence, 'reinstall')], {
    env: { ...env, METAWORK_PACKAGED_REAL_TASK: '0', METAWORK_PACKAGED_EXPECT_EXISTING: '1' }, timeout: 240000,
  });
  const release = await realpath(join(account, 'installation/app/current'));
  const Database = createRequire(join(release, 'package.json'))('better-sqlite3');
  const db = new Database(join(account, 'installation/accounts/local-default/data/anyfusion.db'), { readonly: true });
  try {
    const tasks = JSON.parse(await readFile(join(evidence, 'real-model-task.json'), 'utf8'));
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(tasks.artifactTaskId)?.status, 'done');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(tasks.cancelledTaskId)?.status, 'cancelled');
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally { db.close(); }
  await uninstall();
  Object.assign(report, { passed: true, currentUserInstall: true, realTasks: true, threeClients: true,
    activeUninstallDeclined: true, uninstallReinstallPreservedTasks: true });
} finally {
  await writeFile(join(evidence, 'windows11-product.json'), JSON.stringify(report, null, 2));
}
