import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  isolateInterruptedInstallation,
  restoreInterruptedInstallation,
} from '../main/interrupted-install-recovery.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'desktop-interrupted-install-'));
  roots.push(parent);
  const root = join(parent, '.metawork');
  await mkdir(join(root, 'app/releases/old'), { recursive: true });
  await writeFile(join(root, 'app/releases/old/release-identity.json'), 'old release');
  return { parent, root };
}

it('isolates an interrupted installation, restores it after install failure, and retains the backup during clean installation', async () => {
  const { root } = await fixture();
  const oldRelease = join(root, 'app/releases/old/release-identity.json');
  await chmod(oldRelease, 0o444);

  const backup = await isolateInterruptedInstallation(root);
  expect(backup).toBeTruthy();
  await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(backup!, 'app/releases/old/release-identity.json'), 'utf8')).resolves.toBe('old release');

  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'partial-install'), 'partial');
  await restoreInterruptedInstallation(root, backup!);
  await expect(readFile(oldRelease, 'utf8')).resolves.toBe('old release');
  await expect(lstat(join(root, 'partial-install'))).rejects.toMatchObject({ code: 'ENOENT' });

  const secondBackup = await isolateInterruptedInstallation(root);
  expect(secondBackup).toBeTruthy();
  await mkdir(root, { recursive: true });
  await expect(readFile(join(secondBackup!, 'app/releases/old/release-identity.json'), 'utf8')).resolves.toBe('old release');
});

it('refuses to move a root while its Server process is alive', async () => {
  const { root } = await fixture();
  const lock = join(root, 'accounts/local-default/data/runtime.lock');
  await mkdir(join(root, 'accounts/local-default/data'), { recursive: true });
  await writeFile(lock, JSON.stringify({ pid: String(process.pid) }));

  await expect(isolateInterruptedInstallation(root)).rejects.toThrow('Previous MetaWork Server is still running');
  await expect(readFile(join(root, 'app/releases/old/release-identity.json'), 'utf8')).resolves.toBe('old release');
});

it('refuses a live update helper before touching the installation', async () => {
  const { root } = await fixture();
  const lock = join(root, 'upgrades/desktop-helper.lock');
  await mkdir(join(root, 'upgrades'), { recursive: true });
  await writeFile(lock, String(process.pid));

  await expect(isolateInterruptedInstallation(root)).rejects.toThrow('Previous Desktop update helper is still running');
  await expect(readFile(join(root, 'app/releases/old/release-identity.json'), 'utf8')).resolves.toBe('old release');
});
