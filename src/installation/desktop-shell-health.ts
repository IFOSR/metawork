import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DesktopShellHealth {
  challenge: string;
  releaseId: string;
  instanceId: string;
  pid: number;
}

/** A per-activation receipt, written only after authenticated Web assets render. */
export async function writeDesktopShellHealth(root: string, health: DesktopShellHealth): Promise<void> {
  const path = join(root, 'upgrades/desktop-shell-health.json');
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(health), { mode: 0o600 });
  await rename(temporary, path);
}

export async function waitForDesktopShellHealth(root: string, expected: DesktopShellHealth, options: {
  alive(): boolean; timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  do {
    if (!options.alive()) throw new Error('Candidate desktop exited before health verification');
    const raw = await readFile(join(root, 'upgrades/desktop-shell-health.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
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
}): Promise<boolean> {
  if (!/^[a-f0-9-]{36}$/u.test(input.challenge)) return false;
  const [request, journal] = await Promise.all([
    readFile(join(root, 'upgrades/desktop-request.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'upgrades/desktop-activation.json'), 'utf8').then(JSON.parse),
  ]);
  return request.shellChallenge === input.challenge && journal.phase === 'shell-replaced'
    && request.record.candidateReleaseId === input.releaseId && journal.candidateReleaseId === input.releaseId
    && request.record.applicationPath === input.applicationPath && journal.applicationPath === input.applicationPath
    && request.record.backupApplicationPath === journal.backupApplicationPath;
}
