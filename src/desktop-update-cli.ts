import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
import { runDesktopUpdateTransaction } from './installation/desktop-update-transaction.js';
import { DesktopUpdateDiagnostics } from './installation/desktop-update-diagnostics.js';
import { resolveDesktopUpdateRoot } from './installation/desktop-update-request.js';

async function main(): Promise<void> {
  const [rootArg, requestArg] = process.argv.slice(2);
  if (!rootArg || !requestArg) throw new Error('Missing update request');
  // Preserve the installation's selected spelling for the durable request paths.
  // macOS /tmp (and user-selected data directories) may be symlinks. Compare the
  // request's physical identity without mixing canonical and logical prefixes.
  const root = await resolveDesktopUpdateRoot(rootArg, requestArg);
  const requests = join(root, 'upgrades');
  const request = JSON.parse(await readFile(requestArg, 'utf8')) as {
    record: Omit<DesktopActivationRecord, 'schemaVersion' | 'phase'>;
    previousNode: string; previousPid: number; trustedKeys: Record<string, string>; desktopVersion: string;
    shellChallenge: string;
    configHome?: string;
    userDataPath?: string;
    recoverOnly?: boolean;
    launchToken?: string;
  };
  const record = request.record;
  if (!record.applicationPath.endsWith('.app') || !record.stagedApplicationPath.startsWith(`${requests}/`)
    || !record.backupApplicationPath.startsWith(`${record.applicationPath}.metawork-backup-`)
    || !/^[a-f0-9-]{36}$/u.test(record.backupApplicationPath.slice(`${record.applicationPath}.metawork-backup-`.length))) throw new Error('Invalid application paths');
  await mkdir(requests, { recursive: true, mode: 0o700 });
  const lockPath = join(requests, 'desktop-helper.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(async error => {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid helper lock');
    try { process.kill(pid, 0); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ESRCH') { await rm(lockPath); return open(lockPath, 'wx', 0o600); }
      throw cause;
    }
    throw new Error('Another desktop update is running');
  });
  await lock.writeFile(String(process.pid)); await lock.close();
  let lockReleased = false;
  const releaseLock = async () => {
    if (lockReleased) return;
    await rm(lockPath, { force: true });
    lockReleased = true;
  };
  const diagnostics = new DesktopUpdateDiagnostics(root, request.recoverOnly ? 'repair' : 'update');
  await diagnostics.finish('running');
  try {
    const resources = join(record.stagedApplicationPath, 'Contents/Resources');
    let candidateShell: ChildProcess | undefined;
    const startShell = (challenge?: string) => {
      const env: NodeJS.ProcessEnv = { ...process.env, METAWORK_INSTALL_ROOT: root, ANYFUSION_INSTALL_ROOT: root,
        ...(request.configHome ? { METAWORK_CONFIG_HOME: request.configHome, ANYFUSION_CONFIG_HOME: request.configHome } : {}) };
      for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key];
      return spawn(join(record.applicationPath, 'Contents/MacOS/MetaWork'),
        [...(request.userDataPath ? [`--user-data-dir=${request.userDataPath}`] : []),
          ...(challenge ? [`--metawork-update-check=${challenge}`] : [])], { detached: true, stdio: 'ignore', env });
    };
    const paths = resolveMetaWorkPaths(undefined, root);
    const running = () => isInstanceRunning(join(root, 'data/runtime.lock'));
    const currentIdentity = () => readReleaseIdentity(join(root, 'app/current/release-identity.json'));
    const manager = async () => {
      const identity = await currentIdentity(); if (!identity) throw new Error('No current runtime');
      const releaseRoot = await realpath(join(root, 'app/current'));
      const nodePath = await access(join(releaseRoot, 'desktop-tools/node/bin/node')).then(
        () => join(releaseRoot, 'desktop-tools/node/bin/node'), () => request.previousNode);
      return new DesktopServiceManager({ installRoot: root, releaseId: identity.releaseId, nodePath, configHome: request.configHome });
    };
    const helperTools = resolve(dirname(process.execPath), '../..');
    const updater = new SourceNativeUpdater({ paths,
      secretStore: createProductionSecretStore({ credentialsFile: paths.credentials }),
      isServerRunning: running, installLaunchers: false,
      detectCommand: name => commandExistsOnPath(name, [join(resources, 'payload/metawork/desktop-tools/node/bin'),
        join(resources, 'payload/metawork/desktop-tools/git/bin'), join(resources, 'payload/metawork/desktop-tools/executor/bin'),
        join(helperTools, 'node/bin'), join(helperTools, 'git/bin'), join(helperTools, 'executor/bin'),
        process.env.PATH ?? '/usr/bin:/bin'].join(':')),
    });
    const activation = new DesktopActivation(join(requests, 'desktop-activation.json'), diagnostics.observe({
      verify: async () => {
        const descriptor = JSON.parse(await readFile(join(resources, 'desktop-release.json'), 'utf8'));
        const release = await verifyDesktopRelease(resources, { trustedKeys: request.trustedKeys, arch: process.arch,
          desktopVersion: request.desktopVersion, allowDevelopment: descriptor.development === true });
        if (release.releaseId !== record.candidateReleaseId || !/^[a-f0-9-]{36}$/u.test(request.shellChallenge)) throw new Error('Candidate release mismatch');
        if ((await currentIdentity())?.releaseId !== record.previousReleaseId) throw new Error('Previous runtime changed');
        if (await access(record.backupApplicationPath).then(() => true, () => false)) throw new Error('Previous application backup must be retained or archived first');
      },
      stop: async () => {
        if (candidateShell && candidateShell.exitCode === null && candidateShell.signalCode === null) {
          candidateShell.kill('SIGTERM');
          const deadline = Date.now() + 15_000;
          while (candidateShell.exitCode === null && candidateShell.signalCode === null) {
            if (Date.now() >= deadline) throw new Error('Candidate desktop must exit before recovery');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        if (await running()) await (await manager()).stopForUpdate();
      },
      updateRuntime: () => updater.update({ releaseId: record.candidateReleaseId,
        sourceRoot: join(resources, 'payload/metawork'), plannerRoot: join(resources, 'payload/planner') }).then(() => undefined),
      replaceShell: async () => {
        const stagedSibling = `${record.applicationPath}.metawork-staged`;
        await cp(record.stagedApplicationPath, stagedSibling, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        await rename(record.applicationPath, record.backupApplicationPath);
        await rename(stagedSibling, record.applicationPath);
      },
      startAndVerifyCandidate: async () => {
        const grant = await (await manager()).connect();
        if (grant.releaseId !== record.candidateReleaseId) throw new Error('Candidate runtime failed health check');
        candidateShell = startShell(request.shellChallenge);
        await new Promise<void>((resolve, reject) => {
          candidateShell!.once('spawn', resolve); candidateShell!.once('error', reject);
        });
        await waitForDesktopShellHealth(root, { challenge: request.shellChallenge, releaseId: grant.releaseId,
          instanceId: grant.instanceId, pid: candidateShell.pid! }, {
          alive: () => candidateShell!.exitCode === null && candidateShell!.signalCode === null,
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
      startPrevious: async () => { await (await manager()).startForUpdate(); },
    }));
    // The helper is independent of Electron; wait for client exit before replacing its bundle.
    if (request.launchToken) {
      if (!/^[a-f0-9-]{36}$/u.test(request.launchToken)) throw new Error('Invalid helper launch token');
      const ready = join(requests, 'desktop-helper-ready.json');
      await writeFile(`${ready}.tmp`, JSON.stringify({ token: request.launchToken, pid: process.pid }), { mode: 0o600 });
      await rename(`${ready}.tmp`, ready);
    }
    process.stdout.write('READY\n');
    const deadline = Date.now() + 60_000;
    while (request.previousPid !== process.pid) {
      let alive = true;
      try { process.kill(request.previousPid, 0); } catch { alive = false; }
      if (!alive) break;
      if (Date.now() > deadline) throw new Error('Desktop did not exit');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await runDesktopUpdateTransaction({ activation, record, recoverOnly: request.recoverOnly === true,
      candidateRunning: () => Boolean(candidateShell && candidateShell.exitCode === null && candidateShell.signalCode === null),
      finalize: async () => {
        await rm(record.backupApplicationPath, { recursive: true, force: true });
        await rm(record.stagedApplicationPath, { recursive: true, force: true });
        await rm(dirname(record.stagedApplicationPath), { recursive: true, force: true });
      },
      releaseLock,
      relaunch: () => { const child = startShell(); child.unref(); },
    });
    const completed = await activation.read();
    await diagnostics.finish(completed?.phase === 'committed' ? 'committed' : 'rolled-back');
  } catch (error) {
    const phase = await readFile(join(requests, 'desktop-activation.json'), 'utf8')
      .then(raw => JSON.parse(raw).phase, () => null).catch(() => null);
    await diagnostics.finish(phase === 'rolled-back' ? 'rolled-back' : 'failed', error);
    throw error;
  } finally { await releaseLock(); }
}
void main().catch(async () => {
  // Preserve the activation record; the UI must not bypass failed recovery.
  process.stderr.write('Desktop update requires recovery; previous data and activation journals were retained.\n');
  process.exitCode = 1;
});
