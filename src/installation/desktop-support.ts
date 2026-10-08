import { randomUUID } from 'node:crypto';
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopInventory, type DesktopRelease } from './desktop-release.js';

export function desktopSupportRoot(root: string, releaseId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseId)) throw new Error('Invalid Desktop support release');
  return join(root, 'desktop-support', releaseId);
}

/** Called only after verifying the signed payload. Never edits the active release. */
export async function prepareDesktopSupport(resources: string, root: string, release: DesktopRelease): Promise<void> {
  const destination = desktopSupportRoot(root, release.releaseId);
  const expected = Object.fromEntries(Object.entries(release.files)
    .filter(([name]) => name.startsWith('metawork/'))
    .map(([name, value]) => [name.slice('metawork/'.length), value]));
  async function verify(path: string): Promise<void> {
    const actual = await desktopInventory(path);
    if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort())
      || Object.entries(actual).some(([name, value]) => {
        const file = expected[name];
        return !file || file.sha256 !== value.sha256 || file.size !== value.size || file.executable !== value.executable;
      })) throw new Error('Desktop support integrity mismatch');
  }
  try { await verify(destination); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(join(root, 'desktop-support'), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    await cp(join(resources, 'payload/metawork'), temporary, { recursive: true, errorOnExist: true, force: false });
    await verify(temporary);
    try { await rename(temporary, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await verify(destination);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
