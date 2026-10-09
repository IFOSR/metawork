import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { uninstallReceiptPath, writeUninstallReceipt } from '../main/uninstall.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('NSIS uninstall acknowledgment', () => {
  it('writes one bounded acknowledgment only inside a temporary child directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uninstall-')); roots.push(root);
    const plugin = join(root, 'plugin'); await mkdir(plugin);
    const path = await uninstallReceiptPath(join(plugin, 'metawork-uninstall-result'), root);
    await writeUninstallReceipt(path, true);
    expect(await readFile(path, 'utf8')).toBe(`approved\r\n${process.pid}\r\n`);
    await expect(writeUninstallReceipt(path, false)).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(uninstallReceiptPath(join(root, 'metawork-uninstall-result'), root)).rejects.toThrow('escapes');
    await expect(uninstallReceiptPath(join(plugin, 'other-file'), root)).rejects.toThrow('Invalid');
  });
  it('rejects a temporary child redirected outside the temporary root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uninstall-')); roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), 'outside-')); roots.push(outside);
    await symlink(outside, join(root, 'redirected'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(uninstallReceiptPath(join(root, 'redirected/metawork-uninstall-result'), root)).rejects.toThrow('escapes');
  });
});
