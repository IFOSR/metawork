import { randomUUID } from 'node:crypto';
import { cp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopInventory, type DesktopRelease } from './desktop-release.js';
import { readReleaseIdentity } from './release-identity.js';
import { acquireRuntimeUpdateLock } from './runtime-update-lock.js';

export function recoveredToolsPath(root: string, releaseId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseId)) throw new Error('Invalid release identity');
  return join(root, 'desktop-support', `${releaseId}.tools`);
}

export async function verifyManagedPi(tools: string, release: DesktopRelease): Promise<boolean> {
  try {
    const actual = await desktopInventory(join(tools, 'executor'));
    const prefix = 'metawork/desktop-tools/executor/';
    const expected = Object.fromEntries(Object.entries(release.files)
      .filter(([name]) => name.startsWith(prefix)).map(([name, value]) => [name.slice(prefix.length), value]));
    return Object.keys(expected).length > 0 && Object.keys(actual).length === Object.keys(expected).length
      && Object.entries(expected).every(([name, file]) => actual[name]?.sha256 === file.sha256
        && actual[name]?.size === file.size && actual[name]?.executable === file.executable);
  } catch { return false; }
}

/** Caller verifies the signed payload and stops Server through its formal lifecycle first. */
export async function restoreManagedTools(resources: string, root: string, release: DesktopRelease): Promise<void> {
  const lock = await acquireRuntimeUpdateLock(root, 'update');
  let temporary: string | undefined;
  try {
    const current = await readReleaseIdentity(join(root, 'app/current/release-identity.json'));
    if (current?.releaseId !== release.releaseId) throw new Error('Managed tools release mismatch');
    const pointer = recoveredToolsPath(root, release.releaseId);
    await mkdir(join(root, 'desktop-support'), { recursive: true, mode: 0o700 });
    const candidate = join(root, 'desktop-support', `${release.releaseId}-tools-${randomUUID()}`);
    temporary = candidate;
    await cp(join(resources, 'payload/metawork/desktop-tools'), candidate, { recursive: true });
    const actual = await desktopInventory(candidate);
    const prefix = 'metawork/desktop-tools/';
    const expected = Object.fromEntries(Object.entries(release.files)
      .filter(([name]) => name.startsWith(prefix)).map(([name, value]) => [name.slice(prefix.length), value]));
    if (Object.keys(actual).length !== Object.keys(expected).length || Object.entries(expected).some(([name, file]) =>
      actual[name]?.sha256 !== file.sha256 || actual[name]?.size !== file.size || actual[name]?.executable !== file.executable)) {
      throw new Error('Managed tools integrity mismatch');
    }
    const next = `${pointer}.${randomUUID()}.tmp`;
    await symlink(candidate, next);
    await rename(next, pointer);
    temporary = undefined; // Activated tree is immutable; do not edit the original release.
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await lock.release();
  }
}

/** Durable once-per-release automatic attempt. Explicit retries remain available. */
export async function claimAutomaticPiRepair(root: string, releaseId: string): Promise<boolean> {
  recoveredToolsPath(root, releaseId);
  const directory = join(root, 'upgrades');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(directory, `pi-repair-${releaseId}.json`), JSON.stringify({ releaseId, attemptedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}
