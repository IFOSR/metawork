import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { DesktopActivation, type DesktopActivationRecord } from './installation/desktop-activation.js';
import { verifyDesktopRelease } from './installation/desktop-release.js';
import { readReleaseIdentity } from './installation/release-identity.js';
import { SourceNativeUpdater } from './installation/source-native-updater.js';
import { resolveMetaWorkPaths } from './installation/paths.js';
import { createProductionSecretStore } from './configuration/production-secret-store.js';
import { commandExistsOnPath } from './configuration/production-configuration-probe.js';
import { DesktopServiceManager } from './client/desktop-service-manager.js';
import { isInstanceRunning } from './management/lock.js';
import { waitForDesktopShellHealth } from './installation/desktop-shell-health.js';
import { assertDesktopActivationPaths, desktopApplicationPaths, desktopProcessEnvironment, desktopToolPaths } from './installation/desktop-platform.js';
import { loadWindowsPrivateFiles, writeWindowsPrivateJson } from './platform/windows-private-files.js';
import { desktopInstallFailure } from './installation/desktop-install-progress.js';

async function main(): Promise<void> {
  const [rootArg, requestArg] = process.argv.slice(2);
  if (!rootArg || !requestArg) throw new Error('Missing update request');
  const root = await realpath(rootArg);
  const requests = join(root, 'upgrades');
  if (await realpath(requestArg) !== join(requests, 'desktop-request.json')) throw new Error('Invalid update request path');
  const windows = process.platform === 'win32' ? { root,
    files: loadWindowsPrivateFiles(join(root, 'app/current/native/windows/metawork-platform.node')) } : undefined;
  const readPrivate = (path: string) => windows
    ? Promise.resolve().then(() => windows.files.readPrivateFile(root, relative(root, path)).toString('utf8')) : readFile(path, 'utf8');
  const request = JSON.parse(await readPrivate(requestArg)) as {
    record: Omit<DesktopActivationRecord, 'schemaVersion' | 'phase'>;
    previousNode: string; previousPid: number; trustedKeys: Record<string, string>; desktopVersion: string;
    shellChallenge: string;
    configHome?: string; userDataPath?: string;
  };
  const record = request.record;
  assertDesktopActivationPaths(root, record);
  await mkdir(requests, { recursive: true, mode: 0o700 });
  const lockPath = join(requests, 'desktop-helper.lock');
  const createLock = async (): Promise<void> => {
    if (windows) windows.files.createPrivateFile(root, relative(root, lockPath), Buffer.from(String(process.pid)));
    else {
      const file = await open(lockPath, 'wx', 0o600);
      try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
    }
  };
  const removeLock = async (): Promise<void> => {
    if (windows) windows.files.removePrivateFile(root, relative(root, lockPath));
    else await rm(lockPath, { force: true });
  };
  await createLock().catch(async error => {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readPrivate(lockPath));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid helper lock');
    try { process.kill(pid, 0); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ESRCH') { await removeLock(); return createLock(); }
      throw cause;
    }
    throw new Error('Another desktop update is running');
  });
  try {
    const resources = desktopApplicationPaths(record.stagedApplicationPath).resources;
    let candidateShell: ChildProcess | undefined;
    const paths = resolveMetaWorkPaths(undefined, root);
    const running = () => isInstanceRunning(join(root, 'data/runtime.lock'));
    const currentIdentity = () => readReleaseIdentity(join(root, 'app/current/release-identity.json'));
    const manager = async () => {
      const identity = await currentIdentity(); if (!identity) throw new Error('No current runtime');
      const releaseRoot = await realpath(join(root, 'app/current'));
      const nodePath = await access(desktopToolPaths(releaseRoot).node).then(
        () => desktopToolPaths(releaseRoot).node, () => request.previousNode);
      return new DesktopServiceManager({ installRoot: root, releaseId: identity.releaseId, nodePath, configHome: request.configHome });
    };
    const updater = new SourceNativeUpdater({ paths,
      secretStore: createProductionSecretStore({ credentialsFile: paths.credentials, windows }),
      isServerRunning: running, installLaunchers: false, windows,
      detectCommand: name => commandExistsOnPath(name, desktopProcessEnvironment({
        releaseRoot: join(resources, 'payload/metawork'),
        nodePath: desktopToolPaths(join(resources, 'payload/metawork')).node, env: process.env,
      }).PATH),
    });
    const activation = new DesktopActivation(join(requests, 'desktop-activation.json'), {
      verify: async () => {
        const release = await verifyDesktopRelease(resources, { trustedKeys: request.trustedKeys, platform: process.platform, arch: process.arch,
          desktopVersion: request.desktopVersion, allowDevelopment: process.env.METAWORK_DESKTOP_INTERNAL === '1' });
        if (release.releaseId !== record.candidateReleaseId || !/^[a-f0-9-]{36}$/u.test(request.shellChallenge)) throw new Error('Candidate release mismatch');
        if ((await currentIdentity())?.releaseId !== record.previousReleaseId) throw new Error('Previous runtime changed');
        if (await access(record.backupApplicationPath).then(() => true, () => false)) throw new Error('Previous application backup must be retained or archived first');
      },
      stop: async () => {
        if (candidateShell && candidateShell.exitCode === null && candidateShell.signalCode === null) {
          if (windows) {
            await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'),
              ['/PID', String(candidateShell.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
          } else candidateShell.kill('SIGTERM');
          const deadline = Date.now() + 15_000;
          while (candidateShell.exitCode === null && candidateShell.signalCode === null) {
            if (Date.now() >= deadline) throw new Error('Candidate desktop must exit before recovery');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        if (await running()) await (await manager()).stop();
      },
      updateRuntime: () => updater.update({ releaseId: record.candidateReleaseId,
        sourceRoot: join(resources, 'payload/metawork'), plannerRoot: join(resources, 'payload/planner') }).then(() => undefined),
      replaceShell: async () => {
        const stagedSibling = `${record.applicationPath}.metawork-staged`;
        await cp(record.stagedApplicationPath, stagedSibling, { recursive: true, errorOnExist: true, force: false });
        await rename(record.applicationPath, record.backupApplicationPath);
        await rename(stagedSibling, record.applicationPath);
      },
      startAndVerifyCandidate: async () => {
        const grant = await (await manager()).connect();
        if (grant.releaseId !== record.candidateReleaseId) throw new Error('Candidate runtime failed health check');
        const env = { ...process.env, METAWORK_INSTALL_ROOT: root, ANYFUSION_INSTALL_ROOT: root,
          ...(request.configHome ? { METAWORK_CONFIG_HOME: request.configHome, ANYFUSION_CONFIG_HOME: request.configHome } : {}) };
        for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key as keyof typeof env];
        candidateShell = spawn(desktopApplicationPaths(record.applicationPath).executable,
          [`--metawork-update-check=${request.shellChallenge}`, ...(request.userDataPath ? [`--user-data-dir=${request.userDataPath}`] : [])],
          { detached: true, stdio: 'ignore', env });
        await new Promise<void>((resolve, reject) => {
          candidateShell!.once('spawn', resolve); candidateShell!.once('error', reject);
        });
        await waitForDesktopShellHealth(root, { challenge: request.shellChallenge, releaseId: grant.releaseId,
          instanceId: grant.instanceId, pid: candidateShell.pid! }, {
          alive: () => candidateShell!.exitCode === null && candidateShell!.signalCode === null,
          windows,
        });
        candidateShell.unref();
      },
      restoreRuntime: async () => {
        await updater.recoverInterruptedActivation();
        if ((await currentIdentity())?.releaseId !== record.previousReleaseId) await updater.rollback(record.previousReleaseId);
      },
      restoreShell: async () => {
        if (await access(record.backupApplicationPath).then(() => true, () => false)) {
          if (await access(record.applicationPath).then(() => true, () => false)) await rename(record.applicationPath, `${record.applicationPath}.metawork-failed-${randomUUID()}`);
          await rename(record.backupApplicationPath, record.applicationPath);
        }
        await rm(`${record.applicationPath}.metawork-staged`, { recursive: true, force: true });
      },
      startPrevious: async () => { await (await manager()).connect(); },
    }, windows);
    const reopen = () => {
      const env = { ...process.env, METAWORK_INSTALL_ROOT: root, ANYFUSION_INSTALL_ROOT: root,
        ...(request.configHome ? { METAWORK_CONFIG_HOME: request.configHome, ANYFUSION_CONFIG_HOME: request.configHome } : {}) };
      const child = windows
        ? spawn(desktopApplicationPaths(record.applicationPath).executable,
          request.userDataPath ? [`--user-data-dir=${request.userDataPath}`] : [], { detached: true, stdio: 'ignore', env })
        : spawn('/usr/bin/open', [record.applicationPath,
          ...(request.userDataPath ? ['--args', `--user-data-dir=${request.userDataPath}`] : [])], { detached: true, stdio: 'ignore', env });
      child.unref();
    };
    // The helper is independent of Electron; wait for client exit before replacing its bundle.
    process.stdout.write('READY\n');
    const deadline = Date.now() + 60_000;
    while (request.previousPid !== process.pid) {
      let alive = true;
      try { process.kill(request.previousPid, 0); } catch { alive = false; }
      if (!alive) break;
      if (Date.now() > deadline) throw new Error('Desktop did not exit');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const prior = await activation.read();
    if (prior && !['committed', 'rolled-back'].includes(prior.phase)) {
      for (const key of ['applicationPath', 'stagedApplicationPath', 'backupApplicationPath', 'previousReleaseId', 'candidateReleaseId'] as const) {
        if (prior[key] !== record[key]) throw new Error('Recovery request does not match activation journal');
      }
      await activation.recover();
    } else {
      try { await activation.apply(record); }
      catch (error) {
        if ((await activation.read())?.phase === 'rolled-back') {
          reopen();
        }
        throw error;
      }
    }
    if (!candidateShell || candidateShell.exitCode !== null || candidateShell.signalCode !== null) {
      reopen();
    }
  } catch (error) {
    const path = join(requests, 'desktop-update-failure.json');
    try {
      if (windows) writeWindowsPrivateJson(windows, path, desktopInstallFailure(error));
      else await writeFile(path, JSON.stringify(desktopInstallFailure(error)), { mode: 0o600 });
    } catch { /* Keep the original activation failure and recovery journal. */ }
    throw error;
  } finally { await removeLock(); }
}
void main().catch(async () => {
  // Preserve the activation record; the UI must not bypass failed recovery.
  process.stderr.write('Desktop update requires recovery; previous data and activation journals were retained.\n');
  process.exitCode = 1;
});
