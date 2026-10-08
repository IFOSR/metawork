import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { writeWindowsPrivateJson, type WindowsPrivateFileRoot } from '../platform/windows-private-files.js';

export interface DesktopShellHealth {
  challenge: string;
  releaseId: string;
  instanceId: string;
  pid: number;
}

/** A per-activation receipt, written only after authenticated Web assets render. */
export async function writeDesktopShellHealth(root: string, health: DesktopShellHealth, windows?: WindowsPrivateFileRoot): Promise<void> {
  const path = join(root, 'upgrades/desktop-shell-health.json');
  if (windows) { writeWindowsPrivateJson(windows, path, health); return; }
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(health), { mode: 0o600 });
  await rename(temporary, path);
}

export async function waitForDesktopShellHealth(root: string, expected: DesktopShellHealth, options: {
  alive(): boolean; timeoutMs?: number; windows?: WindowsPrivateFileRoot;
}): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  do {
    if (!options.alive()) throw new Error('Candidate desktop exited before health verification');
    const raw = await readHealthFile(root, 'desktop-shell-health.json', options.windows).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw) {
      const receipt = JSON.parse(raw) as DesktopShellHealth;
      if (receipt.challenge === expected.challenge && receipt.releaseId === expected.releaseId
        && receipt.instanceId === expected.instanceId && receipt.pid === expected.pid) return;
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() <= deadline);
  throw new Error('Candidate desktop did not confirm authenticated Web readiness');
}

export async function authorizeDesktopShellCheck(root: string, input: {
  challenge: string; applicationPath: string; releaseId: string;
}, windows?: WindowsPrivateFileRoot): Promise<boolean> {
  if (!/^[a-f0-9-]{36}$/u.test(input.challenge)) return false;
  const [request, journal] = await Promise.all([
    readHealthFile(root, 'desktop-request.json', windows).then(JSON.parse),
    readHealthFile(root, 'desktop-activation.json', windows).then(JSON.parse),
  ]);
  return request.shellChallenge === input.challenge && journal.phase === 'shell-replaced'
    && request.record.candidateReleaseId === input.releaseId && journal.candidateReleaseId === input.releaseId
    && request.record.applicationPath === input.applicationPath && journal.applicationPath === input.applicationPath
    && request.record.backupApplicationPath === journal.backupApplicationPath;
}

async function readHealthFile(root: string, name: string, windows?: WindowsPrivateFileRoot): Promise<string> {
  const path = join(root, 'upgrades', name);
  return windows ? windows.files.readPrivateFile(windows.root, relative(windows.root, path)).toString('utf8')
    : readFile(path, 'utf8');
}
