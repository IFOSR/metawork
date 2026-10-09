import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pendingDesktopUpdate } from '../main/update.js';
import type { WindowsPrivateFiles } from '../../../src/platform/windows-private-files.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('Desktop pending activation gate', () => {
  it('blocks private Windows read failures instead of treating them as no pending update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-update-')); roots.push(root);
    await mkdir(join(root, 'upgrades'));
    const readPrivateFile = vi.fn(() => { throw Object.assign(new Error('untrusted path'), { code: 'EACCES' }); });
    await expect(pendingDesktopUpdate(root, { root, files: { readPrivateFile } as unknown as WindowsPrivateFiles }))
      .rejects.toThrow('untrusted path');
    expect(readPrivateFile).toHaveBeenCalledOnce();
  });
  it('allows a clean installation and retains unfinished activation gates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-update-')); roots.push(root);
    expect(await pendingDesktopUpdate(root)).toBe(false);
    await mkdir(join(root, 'upgrades'));
    for (const phase of ['prepared', 'runtime-updated', 'shell-replaced', 'committed', 'rolled-back']) {
      await writeFile(join(root, 'upgrades/desktop-activation.json'), JSON.stringify({ phase }));
      expect(await pendingDesktopUpdate(root)).toBe(!['committed', 'rolled-back'].includes(phase));
    }
    await writeFile(join(root, 'upgrades/desktop-helper.lock'), String(process.pid));
    expect(await pendingDesktopUpdate(root)).toBe(true);
  });
});
