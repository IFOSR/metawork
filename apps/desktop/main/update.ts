import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyDesktopRelease } from '../../../src/installation/desktop-release.js';
import { readReleaseIdentity } from '../../../src/installation/release-identity.js';
import { decideReleaseCompatibility, parseReleaseManifest } from '../../../src/installation/release-manifest.js';
import { allowDevelopmentPayload } from '../shared/build-policy.js';
import { assertDesktopActivationPaths, desktopApplicationPaths, desktopReleaseRootFromNode, desktopToolPaths } from '../../../src/installation/desktop-platform.js';
import { loadWindowsPrivateFiles, writeWindowsPrivateJson, type WindowsPrivateFileRoot } from '../../../src/platform/windows-private-files.js';

export async function pendingDesktopUpdate(root: string, windows?: WindowsPrivateFileRoot): Promise<boolean> {
  const exists = await access(join(root, 'upgrades')).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false; throw error;
  });
  if (!exists) return false;
  const read = (name: string) => windows ? Promise.resolve().then(() =>
    windows.files.readPrivateFile(root, join('upgrades', name)).toString('utf8')) : readFile(join(root, 'upgrades', name), 'utf8');
  const helperPid = await read('desktop-helper.lock').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  if (helperPid && Number.isSafeInteger(Number(helperPid)) && Number(helperPid) > 0) {
    try { process.kill(Number(helperPid), 0); return true; } catch { /* Durable activation below decides recovery. */ }
  }
  const raw = await read('desktop-activation.json').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  return raw !== null && !['committed', 'rolled-back'].includes(JSON.parse(raw).phase);
}
function teamId(path: string): string {
  const signature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', path], { encoding: 'utf8' });
  if (signature.status !== 0) return 'unsigned-internal';
  const details = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', path], { encoding: 'utf8' });
  const team = /^TeamIdentifier=([A-Z0-9]+)$/mu.exec(details.stderr)?.[1];
  if (!team) throw new Error('Application has no Developer ID team');
  return team;
}

export async function prepareDesktopUpdate(input: {
  root: string; applicationPath: string; candidatePath: string; resources: string; configHome?: string; userDataPath?: string;
}): Promise<string> {
  input = { ...input, root: await realpath(input.root) };
  const applicationPath = await realpath(input.applicationPath);
  let candidatePath = await realpath(input.candidatePath);
  const windows = process.platform === 'win32' ? { root: input.root,
    files: loadWindowsPrivateFiles(join(input.resources, 'payload/metawork/native/windows/metawork-platform.node')) } : undefined;
  if (await pendingDesktopUpdate(input.root, windows)) throw new Error('Recover the pending update first');
  if (windows) {
    if (!candidatePath.toLowerCase().endsWith('.exe')) throw new Error('Select a MetaWork Windows installer');
  } else if (!applicationPath.endsWith('.app') || !candidatePath.endsWith('.app')) throw new Error('Select a MetaWork application');
  if (candidatePath === applicationPath) throw new Error('Select a different MetaWork application');
  await access(dirname(applicationPath), constants.W_OK);
  const directory = join(input.root, 'upgrades');
  const stageDirectory = join(directory, `desktop-stage-${randomUUID()}`);
  if (windows) windows.files.ensurePrivateDirectory(stageDirectory);
  else await mkdir(stageDirectory, { recursive: true, mode: 0o700 });
  const stagedApplicationPath = join(stageDirectory, windows ? 'MetaWork' : 'MetaWork.app');
  if (windows) {
    // NSIS staging extracts only into a new directory. It neither overwrites
    // an installed shell nor touches registration, shortcuts or Runtime data.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(candidatePath, ['/S', `/metawork-stage=${stagedApplicationPath}`], {
        cwd: stageDirectory, windowsHide: true, stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Candidate extraction failed')));
    });
    candidatePath = await realpath(stagedApplicationPath);
    await access(desktopApplicationPaths(candidatePath).executable);
  } else if (teamId(candidatePath) !== teamId(applicationPath)) throw new Error('Application signing team mismatch');
  const keys = JSON.parse(await readFile(join(input.resources, 'trusted-release-keys.json'), 'utf8')) as Record<string, string>;
  const candidateResources = desktopApplicationPaths(candidatePath).resources;
  const candidateDescriptor = JSON.parse(await readFile(join(candidateResources, 'desktop-release.json'), 'utf8')) as { desktopVersion: string; development?: boolean };
  const candidate = await verifyDesktopRelease(candidateResources, { trustedKeys: keys, platform: process.platform, arch: process.arch,
    desktopVersion: candidateDescriptor.desktopVersion, allowDevelopment: allowDevelopmentPayload(candidateDescriptor.development === true) });
  const previous = await readReleaseIdentity(join(input.root, 'app/current/release-identity.json'));
  if (!previous || previous.releaseId === candidate.releaseId) throw new Error('Select a new compatible release');
  const currentDescriptor = JSON.parse(await readFile(join(input.resources, 'desktop-release.json'), 'utf8'));
  const compatibility = decideReleaseCompatibility({ mode: 'update', currentReleaseId: previous.releaseId,
    candidate: parseReleaseManifest(candidate.runtimeManifest),
    requiredCompatibility: parseReleaseManifest(currentDescriptor.runtimeManifest).compatibility });
  if (!compatibility.ok) throw new Error('Desktop update compatibility mismatch');
  if (!windows) {
    await cp(candidatePath, stagedApplicationPath, { recursive: true });
    if (teamId(stagedApplicationPath) !== teamId(applicationPath)) throw new Error('Staged application signature rejected');
  }
  const previousNode = await realpath(desktopToolPaths(join(input.root, 'app/current')).node);
  const requestPath = join(directory, 'desktop-request.json');
  const request = {
    record: { previousReleaseId: previous.releaseId, candidateReleaseId: candidate.releaseId,
      applicationPath, stagedApplicationPath, backupApplicationPath: `${applicationPath}.metawork-backup-${randomUUID()}` },
    previousNode, previousPid: process.pid, trustedKeys: keys, desktopVersion: candidate.desktopVersion,
    shellChallenge: randomUUID(),
    configHome: input.configHome,
    userDataPath: input.userDataPath,
  };
  assertDesktopActivationPaths(input.root, request.record);
  if (windows) writeWindowsPrivateJson(windows, requestPath, request);
  else {
    await writeFile(`${requestPath}.tmp`, JSON.stringify(request), { mode: 0o600 });
    await rename(`${requestPath}.tmp`, requestPath);
  }
  return requestPath;
}

export async function launchDesktopUpdate(root: string): Promise<void> {
  const requestPath = join(root, 'upgrades/desktop-request.json');
  const windows = process.platform === 'win32' ? { root,
    files: loadWindowsPrivateFiles(join(root, 'app/current/native/windows/metawork-platform.node')) } : undefined;
  const request = JSON.parse(windows
    ? windows.files.readPrivateFile(root, relative(root, requestPath)).toString('utf8') : await readFile(requestPath, 'utf8'));
  request.previousPid = process.pid;
  if (windows) writeWindowsPrivateJson(windows, requestPath, request);
  else await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
  const release = desktopReleaseRootFromNode(request.previousNode);
  const helper = join(release, 'dist/desktop-update-cli.js');
  await access(helper);
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(request.previousNode, [helper, root, requestPath], { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
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
