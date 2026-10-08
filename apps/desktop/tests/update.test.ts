import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopInstallation } from '../main/installation.js';
import { launchDesktopUpdate, prepareDesktopUpdate } from '../main/update.js';
import { desktopSupportRoot } from '../../../src/installation/desktop-support.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('original-fs', async () => ({ promises: await import('node:fs/promises') }));
vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  spawnSync: () => ({ status: 0, stderr: 'TeamIdentifier=not set\n' }),
}));
vi.mock('../../../src/installation/desktop-release.js', () => ({
  verifyDesktopRelease: async () => ({ releaseId: '0.1.5-build-aaaaaaa', desktopVersion: '0.1.5', development: true }),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('stages the downloaded app for native adoption without requiring a previous Desktop Node or helper', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-adopt-'))); roots.push(root);
  const applicationPath = join(root, 'MetaWork.app');
  const resources = join(applicationPath, 'Contents/Resources');
  await mkdir(resources, { recursive: true });
  await writeFile(join(resources, 'trusted-release-keys.json'), '{}');
  await writeFile(join(resources, 'desktop-release.json'), JSON.stringify({
    desktopVersion: '0.1.5', releaseId: '0.1.5-build-aaaaaaa', development: true,
  }));
  await symlink('Resources', join(applicationPath, 'Contents/framework-link'));
  const previous = join(root, 'app/releases/1.2.0-preview.3-build-e33e516-1789389295');
  await mkdir(previous, { recursive: true });
  await writeFile(join(previous, 'release-identity.json'), JSON.stringify({
    version: 1, releaseId: '1.2.0-preview.3-build-e33e516-1789389295', gatewayProtocolVersion: 2,
  }));
  await symlink('releases/1.2.0-preview.3-build-e33e516-1789389295', join(root, 'app/current'));
  const bootstrap = desktopSupportRoot(root, '0.1.5-build-aaaaaaa');
  vi.spyOn(DesktopInstallation.prototype, 'run').mockImplementation(async command => {
    expect(command).toBe('prepare-desktop');
    await mkdir(join(bootstrap, 'desktop-tools/node/bin'), { recursive: true });
    await mkdir(join(bootstrap, 'dist'));
    await writeFile(join(bootstrap, 'desktop-tools/node/bin/node'), 'fixture');
    await writeFile(join(bootstrap, 'dist/desktop-update-cli.js'), 'fixture');
  });
  await prepareDesktopUpdate({ root, applicationPath, candidatePath: applicationPath, resources,
    adoptExistingRuntime: true, userDataPath: join(root, 'desktop-profile') });
  const request = JSON.parse(await readFile(join(root, 'upgrades/desktop-request.json'), 'utf8'));
  expect(request).toMatchObject({ bootstrap, previousNode: join(bootstrap, 'desktop-tools/node/bin/node'),
    userDataPath: join(root, 'desktop-profile'),
    record: { previousReleaseId: '1.2.0-preview.3-build-e33e516-1789389295', candidateReleaseId: '0.1.5-build-aaaaaaa', applicationPath } });
  expect(await readlink(join(request.record.stagedApplicationPath, 'Contents/framework-link'))).toBe('Resources');
  expect(await realpath(join(root, 'app/current'))).toBe(previous);
  const previousIdentity = await readFile(join(previous, 'release-identity.json'), 'utf8');
  await writeFile(join(previous, 'release-identity.json'), JSON.stringify({ version: 1, releaseId: '0.1.6', gatewayProtocolVersion: 2 }));
  await expect(prepareDesktopUpdate({ root, applicationPath, candidatePath: applicationPath, resources,
    adoptExistingRuntime: true })).rejects.toThrow('download a newer Desktop');
  expect(DesktopInstallation.prototype.run).toHaveBeenCalledOnce();
  await writeFile(join(previous, 'release-identity.json'), previousIdentity);
  // Interrupted recovery launches stable support, even if staging is unavailable.
  await rm(request.record.stagedApplicationPath, { recursive: true });
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }), unref: vi.fn() });
    queueMicrotask(() => child.stdout.emit('data', 'READY\n'));
    return child;
  });
  await launchDesktopUpdate(root);
  expect(mocks.spawn).toHaveBeenCalledWith(join(bootstrap, 'desktop-tools/node/bin/node'),
    [join(bootstrap, 'dist/desktop-update-cli.js'), root, join(root, 'upgrades/desktop-request.json')], expect.anything());
});
