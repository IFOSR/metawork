import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { desktopInventory, type DesktopRelease } from '../../src/installation/desktop-release.js';
import { claimAutomaticPiRepair, recoveredToolsPath, restoreManagedTools, verifyManagedPi } from '../../src/installation/managed-pi-recovery.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-repair-')); roots.push(root);
  const resources = join(root, 'resources'); const tools = join(resources, 'payload/metawork/desktop-tools');
  await mkdir(join(tools, 'executor/bin'), { recursive: true });
  await writeFile(join(tools, 'executor/bin/pi'), '#!/bin/sh\necho 1\n', { mode: 0o755 });
  await mkdir(join(root, 'app/current'), { recursive: true });
  await writeFile(join(root, 'app/current/release-identity.json'), JSON.stringify({ version: 1, releaseId: '0.1.9-local', gatewayProtocolVersion: 2 }));
  const release = { releaseId: '0.1.9-local', files: await desktopInventory(join(resources, 'payload')) } as DesktopRelease;
  return { root, resources, release, tools };
}
it('atomically activates verified same-release tools without rewriting the active release', async () => {
  const f = await fixture(); const before = await readFile(join(f.root, 'app/current/release-identity.json'), 'utf8');
  await restoreManagedTools(f.resources, f.root, f.release);
  expect(await verifyManagedPi(recoveredToolsPath(f.root, f.release.releaseId), f.release)).toBe(true);
  expect(await readFile(join(f.root, 'app/current/release-identity.json'), 'utf8')).toBe(before);
  expect(await claimAutomaticPiRepair(f.root, f.release.releaseId)).toBe(true);
  expect(await claimAutomaticPiRepair(f.root, f.release.releaseId)).toBe(false);
});
it('rejects a mismatched release and corrupt source without replacing the working pointer', async () => {
  const f = await fixture(); await restoreManagedTools(f.resources, f.root, f.release);
  const pointer = recoveredToolsPath(f.root, f.release.releaseId); const previous = await realpath(pointer);
  await expect(restoreManagedTools(f.resources, f.root, { ...f.release, releaseId: 'other' })).rejects.toThrow('mismatch');
  await writeFile(join(f.tools, 'executor/bin/pi'), 'corrupt');
  await expect(restoreManagedTools(f.resources, f.root, f.release)).rejects.toThrow('integrity');
  expect(await realpath(pointer)).toBe(previous);
});
