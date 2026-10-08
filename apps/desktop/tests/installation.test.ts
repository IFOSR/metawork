import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopInstallation } from '../main/installation.js';
import type { DesktopRelease } from '../../../src/installation/desktop-release.js';
import { desktopSupportRoot } from '../../../src/installation/desktop-support.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(releaseId: string) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-existing-install-'));
  roots.push(root);
  const releaseRoot = join(root, 'app/releases', releaseId);
  await mkdir(releaseRoot, { recursive: true });
  await symlink(join('releases', releaseId), join(root, 'app/current'));
  const identity = JSON.stringify({ version: 1, releaseId, gatewayProtocolVersion: 2 });
  await writeFile(join(releaseRoot, 'release-identity.json'), identity);
  const installation = new DesktopInstallation(join(root, 'resources'), root, '0.1.5');
  vi.spyOn(installation, 'verify').mockResolvedValue({ releaseId: 'desktop-current' } as DesktopRelease);
  return { installation, releaseRoot, identity };
}

it('reports incompatible native installations before looking for Desktop Node and preserves their identity', async () => {
  const { installation, releaseRoot, identity } = await fixture('1.2.0-preview.3-build-e33e516-1789389295');
  expect(await installation.installed()).toBe(true);
  expect(await installation.needsUpgrade()).toBe(true);
  await expect(installation.nodePath()).rejects.toThrow('Installed release mismatch');
  expect(await readFile(join(releaseRoot, 'release-identity.json'), 'utf8')).toBe(identity);
});

it('resolves bundled Node for a matching installation', async () => {
  const { installation, releaseRoot } = await fixture('desktop-current');
  const bin = join(releaseRoot, 'desktop-tools/node/bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'node'), 'fixture');
  expect(await installation.needsUpgrade()).toBe(false);
  await expect(installation.nodePath()).resolves.toBe(await realpath(join(bin, 'node')));
});

it('provisions matching native installations without reinstalling their account or editing their release', async () => {
  const { installation, releaseRoot, identity } = await fixture('desktop-current');
  const node = join(desktopSupportRoot(installation.root, 'desktop-current'), 'desktop-tools/node/bin/node');
  const run = vi.spyOn(installation, 'run').mockImplementation(async command => {
    expect(command).toBe('prepare-desktop');
    await mkdir(join(node, '..'), { recursive: true });
    await writeFile(node, 'fixture');
  });
  await expect(installation.nodePath()).resolves.toBe(await realpath(installation.root).then(root =>
    join(desktopSupportRoot(root, 'desktop-current'), 'desktop-tools/node/bin/node')));
  expect(run).toHaveBeenCalledOnce();
  expect(await readFile(join(releaseRoot, 'release-identity.json'), 'utf8')).toBe(identity);
});
