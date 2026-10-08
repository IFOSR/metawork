import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { promises as originalFs } from 'original-fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyDesktopRelease } from '../../../src/installation/desktop-release.js';
import { readReleaseIdentity } from '../../../src/installation/release-identity.js';
import { compareSemanticVersions, decideReleaseCompatibility, parseReleaseManifest } from '../../../src/installation/release-manifest.js';
import { desktopSupportRoot } from '../../../src/installation/desktop-support.js';
import { DesktopInstallation } from './installation.js';

export async function pendingDesktopUpdate(root: string): Promise<boolean> {
  const helperPid = await readFile(join(root, 'upgrades/desktop-helper.lock'), 'utf8').catch(() => null);
  if (helperPid && Number.isSafeInteger(Number(helperPid)) && Number(helperPid) > 0) {
    try { process.kill(Number(helperPid), 0); return true; } catch { /* Durable activation below decides recovery. */ }
  }
  const raw = await readFile(join(root, 'upgrades/desktop-activation.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  return raw !== null && !['committed', 'rolled-back'].includes(JSON.parse(raw).phase);
}
function teamId(path: string): string {
  const signature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', path], { encoding: 'utf8' });
  if (signature.status !== 0) return 'unsigned-internal';
  const details = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', path], { encoding: 'utf8' });
  const team = /^TeamIdentifier=([A-Z0-9]+)$/mu.exec(details.stderr)?.[1];
  return team ?? 'unsigned-internal';
}

export async function prepareDesktopUpdate(input: {
  root: string; applicationPath: string; candidatePath: string; resources: string; configHome?: string;
  adoptExistingRuntime?: boolean;
  userDataPath?: string;
}): Promise<string> {
  if (await pendingDesktopUpdate(input.root)) throw new Error('Recover the pending update first');
  const applicationPath = await realpath(input.applicationPath);
  const candidatePath = await realpath(input.candidatePath);
  if (!applicationPath.endsWith('.app') || !candidatePath.endsWith('.app')
    || (input.adoptExistingRuntime ? candidatePath !== applicationPath : candidatePath === applicationPath)) {
    throw new Error('Select a compatible MetaWork application');
  }
  await access(dirname(applicationPath), constants.W_OK);
  if (teamId(candidatePath) !== teamId(applicationPath)) throw new Error('Application signing team mismatch');
  const keys = JSON.parse(await readFile(join(input.resources, 'trusted-release-keys.json'), 'utf8')) as Record<string, string>;
  const candidateResources = join(candidatePath, 'Contents/Resources');
  const candidateDescriptor = JSON.parse(await readFile(join(candidateResources, 'desktop-release.json'), 'utf8')) as { desktopVersion: string; development?: boolean };
  const candidate = await verifyDesktopRelease(candidateResources, { trustedKeys: keys, arch: process.arch,
    desktopVersion: candidateDescriptor.desktopVersion, allowDevelopment: candidateDescriptor.development === true });
  const previous = await readReleaseIdentity(join(input.root, 'app/current/release-identity.json'));
  if (!previous || previous.releaseId === candidate.releaseId) throw new Error('Select a new compatible release');
  const currentDescriptor = JSON.parse(await readFile(join(input.resources, 'desktop-release.json'), 'utf8'));
  if (!input.adoptExistingRuntime) {
    const compatibility = decideReleaseCompatibility({ mode: 'update', currentReleaseId: previous.releaseId,
      candidate: parseReleaseManifest(candidate.runtimeManifest),
      requiredCompatibility: parseReleaseManifest(currentDescriptor.runtimeManifest).compatibility });
    if (!compatibility.ok) throw new Error('Desktop update compatibility mismatch');
  } else {
    // ADR-0045 admits the retired preview numbering into the current product
    // line. It does not authorize replacing a newer stable Runtime with an old DMG.
    const retiredPreview = /^1\.2\.0-preview\./u.test(previous.releaseId) && /^0\.1\./u.test(candidate.releaseId);
    if (!retiredPreview && compareSemanticVersions(candidate.releaseId, previous.releaseId) < 0) {
      throw new Error('Installed Runtime is newer; download a newer Desktop');
    }
  }
  // Native adoption is validated by SourceNativeUpdater's actual schema and
  // configuration gates. Product version numbering changed after the previews.
  // Keep recovery executable outside the staged app and the old active release.
  let bootstrap: string | undefined;
  const bundledPreviousNode = join(input.root, 'app/current/desktop-tools/node/bin/node');
  const needsBootstrap = input.adoptExistingRuntime || !await access(bundledPreviousNode).then(() => true, error => {
    if (error.code === 'ENOENT') return false; throw error;
  });
  if (needsBootstrap) {
    await new DesktopInstallation(input.resources, input.root, currentDescriptor.desktopVersion).run('prepare-desktop');
    bootstrap = desktopSupportRoot(input.root, currentDescriptor.releaseId);
  }
  const directory = join(input.root, 'upgrades');
  const stagedApplicationPath = join(directory, `desktop-stage-${randomUUID()}`, 'MetaWork.app');
  await mkdir(dirname(stagedApplicationPath), { recursive: true, mode: 0o700 });
  // Electron's patched fs treats app.asar as a virtual directory. Copy the
  // physical archive and framework links, not its virtual contents.
  await originalFs.cp(candidatePath, stagedApplicationPath, { recursive: true, verbatimSymlinks: true });
  if (teamId(stagedApplicationPath) !== teamId(applicationPath)) throw new Error('Staged application signature rejected');
  const previousNode = await realpath(bundledPreviousNode).catch(error => {
    if (error.code !== 'ENOENT' || !bootstrap) throw error;
    return realpath(join(bootstrap, 'desktop-tools/node/bin/node'));
  });
  const requestPath = join(directory, 'desktop-request.json');
  await writeFile(`${requestPath}.tmp`, JSON.stringify({
    record: { previousReleaseId: previous.releaseId, candidateReleaseId: candidate.releaseId,
      applicationPath, stagedApplicationPath, backupApplicationPath: `${applicationPath}.metawork-backup-${randomUUID()}` },
    previousNode, previousPid: process.pid, trustedKeys: keys, desktopVersion: candidate.desktopVersion,
    ...(bootstrap ? { bootstrap } : {}),
    shellChallenge: randomUUID(),
    configHome: input.configHome,
    userDataPath: input.userDataPath,
  }), { mode: 0o600 });
  await rename(`${requestPath}.tmp`, requestPath);
  return requestPath;
}

export async function launchDesktopUpdate(root: string, recoverOnly = false): Promise<void> {
  const requestPath = join(root, 'upgrades/desktop-request.json');
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  request.previousPid = process.pid;
  request.recoverOnly = recoverOnly;
  await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
  const release = request.bootstrap ?? await realpath(join(root, 'app/current'));
  const helper = join(release, 'dist/desktop-update-cli.js');
  await access(helper);
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  await new Promise<void>((resolve, reject) => {
    const node = request.bootstrap ? join(request.bootstrap, 'desktop-tools/node/bin/node') : request.previousNode;
    const child = spawn(node, [helper, root, requestPath], { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => reject(new Error('Update helper did not become ready')), 30_000);
    let buffer = '';
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Update helper exited before readiness')); });
    child.stdout.on('data', data => {
      buffer += String(data);
      if (buffer.includes('READY\n')) { clearTimeout(timer); child.stdout.destroy(); child.unref(); resolve(); }
      else if (buffer.length > 1024) { clearTimeout(timer); reject(new Error('Invalid helper handshake')); }
    });
  });
}
