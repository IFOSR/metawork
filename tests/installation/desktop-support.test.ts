import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { desktopInventory, type DesktopRelease } from '../../src/installation/desktop-release.js';
import { desktopSupportRoot, prepareDesktopSupport } from '../../src/installation/desktop-support.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-support-')); roots.push(root);
  const resources = join(root, 'resources');
  await mkdir(join(resources, 'payload/metawork/dist'), { recursive: true });
  await writeFile(join(resources, 'payload/metawork/dist/desktop-update-cli.js'), 'verified helper');
  const release = { releaseId: 'current', files: await desktopInventory(join(resources, 'payload')) } as DesktopRelease;
  return { root, resources, release };
}
it('retains verified recovery code outside the active release and staged app, and reuses it', async () => {
  const { root, resources, release } = await fixture();
  await prepareDesktopSupport(resources, root, release);
  await prepareDesktopSupport(resources, root, release);
  await rm(resources, { recursive: true });
  expect(await readFile(join(desktopSupportRoot(root, release.releaseId), 'dist/desktop-update-cli.js'), 'utf8'))
    .toBe('verified helper');
});
it('does not publish corrupt copies or silently replace a modified recovery helper', async () => {
  const { root, resources, release } = await fixture();
  await writeFile(join(resources, 'payload/metawork/dist/desktop-update-cli.js'), 'modified');
  await expect(prepareDesktopSupport(resources, root, release)).rejects.toThrow('integrity');
  await writeFile(join(resources, 'payload/metawork/dist/desktop-update-cli.js'), 'verified helper');
  await prepareDesktopSupport(resources, root, release);
  await writeFile(join(desktopSupportRoot(root, release.releaseId), 'dist/desktop-update-cli.js'), 'modified');
  await expect(prepareDesktopSupport(resources, root, release)).rejects.toThrow('integrity');
});
