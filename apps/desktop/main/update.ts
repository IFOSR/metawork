import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyDesktopRelease } from '../../../src/installation/desktop-release.js';
import { readReleaseIdentity } from '../../../src/installation/release-identity.js';
import { decideReleaseCompatibility, parseReleaseManifest } from '../../../src/installation/release-manifest.js';

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
  if (signature.status !== 0) throw new Error('Application signature rejected');
  const details = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', path], { encoding: 'utf8' });
  const team = /^TeamIdentifier=([A-Z0-9]+)$/mu.exec(details.stderr)?.[1];
  if (!team) throw new Error('Application has no Developer ID team');
  return team;
}

export async function prepareDesktopUpdate(input: {
  root: string; applicationPath: string; candidatePath: string; resources: string; configHome?: string;
}): Promise<string> {
  if (await pendingDesktopUpdate(input.root)) throw new Error('Recover the pending update first');
  const applicationPath = await realpath(input.applicationPath);
  const candidatePath = await realpath(input.candidatePath);
  if (!applicationPath.endsWith('.app') || !candidatePath.endsWith('.app') || candidatePath === applicationPath) throw new Error('Select a different MetaWork application');
  await access(dirname(applicationPath), constants.W_OK);
  if (teamId(candidatePath) !== teamId(applicationPath)) throw new Error('Application signing team mismatch');
  const keys = JSON.parse(await readFile(join(input.resources, 'trusted-release-keys.json'), 'utf8')) as Record<string, string>;
  const candidateResources = join(candidatePath, 'Contents/Resources');
  const candidateDescriptor = JSON.parse(await readFile(join(candidateResources, 'desktop-release.json'), 'utf8')) as { desktopVersion: string };
  const candidate = await verifyDesktopRelease(candidateResources, { trustedKeys: keys, arch: process.arch, desktopVersion: candidateDescriptor.desktopVersion });
  const previous = await readReleaseIdentity(join(input.root, 'app/current/release-identity.json'));
  if (!previous || previous.releaseId === candidate.releaseId) throw new Error('Select a new compatible release');
  const currentDescriptor = JSON.parse(await readFile(join(input.resources, 'desktop-release.json'), 'utf8'));
  const compatibility = decideReleaseCompatibility({ mode: 'update', currentReleaseId: previous.releaseId,
    candidate: parseReleaseManifest(candidate.runtimeManifest),
    requiredCompatibility: parseReleaseManifest(currentDescriptor.runtimeManifest).compatibility });
  if (!compatibility.ok) throw new Error('Desktop update compatibility mismatch');
  const directory = join(input.root, 'upgrades');
  const stagedApplicationPath = join(directory, `desktop-stage-${randomUUID()}`, 'MetaWork.app');
  await mkdir(dirname(stagedApplicationPath), { recursive: true, mode: 0o700 });
  await cp(candidatePath, stagedApplicationPath, { recursive: true });
  if (teamId(stagedApplicationPath) !== teamId(applicationPath)) throw new Error('Staged application signature rejected');
  const previousNode = await realpath(join(input.root, 'app/current/desktop-tools/node/bin/node'));
  const requestPath = join(directory, 'desktop-request.json');
  await writeFile(`${requestPath}.tmp`, JSON.stringify({
    record: { previousReleaseId: previous.releaseId, candidateReleaseId: candidate.releaseId,
      applicationPath, stagedApplicationPath, backupApplicationPath: `${applicationPath}.metawork-backup-${randomUUID()}` },
    previousNode, previousPid: process.pid, trustedKeys: keys, desktopVersion: candidate.desktopVersion,
    shellChallenge: randomUUID(),
    configHome: input.configHome,
  }), { mode: 0o600 });
  await rename(`${requestPath}.tmp`, requestPath);
  return requestPath;
}

export async function launchDesktopUpdate(root: string): Promise<void> {
  const requestPath = join(root, 'upgrades/desktop-request.json');
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  request.previousPid = process.pid;
  await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
  const release = resolve(dirname(request.previousNode), '../../..');
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
