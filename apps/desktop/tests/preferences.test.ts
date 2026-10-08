import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopPreferenceStore } from '../main/preferences.js';
import { loadWindowsPrivateFiles } from '../../../src/platform/windows-private-files.js';

const privateFiles = process.platform === 'win32' ? loadWindowsPrivateFiles(
  fileURLToPath(new URL('../../../native/windows/build/Release/metawork_platform.node', import.meta.url))) : undefined;
const storeAt = (path: string) => new DesktopPreferenceStore(path, privateFiles);

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('Desktop account preferences', () => {
  it('persists the latest concurrent draft atomically and restores independent of port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-preferences-')); roots.push(root);
    const path = join(root, 'installation/account.json');
    const store = storeAt(path); await store.load();
    await Promise.all(Array.from({ length: 80 }, (_, n) => store.setDraft('conversation', { text: `edit ${n}`, attachments: [] })));
    const restored = storeAt(path); await restored.load();
    expect(restored.read().drafts.conversation.text).toBe('edit 79');
    if (privateFiles) {
      // Real native read refuses broad ACLs, a different owner and reparse/hard links.
      expect(JSON.parse(privateFiles.readPrivateFile(join(root, 'installation'), 'account.json').toString()).drafts.conversation.text).toBe('edit 79');
    } else expect((await stat(path)).mode & 0o077).toBe(0);
    await restored.clearDrafts();
    expect(JSON.parse(await readFile(path, 'utf8')).drafts).toEqual({});
  });
  it('rejects oversized drafts without changing saved user work and scopes accounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-preferences-')); roots.push(root);
    const store = storeAt(join(root, 'private', 'a.json'));
    await store.setDraft('conversation', { text: '保留', attachments: [] });
    await expect(store.setDraft('conversation', { text: 'x'.repeat(50000), attachments: [] })).rejects.toThrow();
    expect(store.read().drafts.conversation.text).toBe('保留');
    await expect(store.setDraft('__proto__', { text: '', attachments: [] })).rejects.toThrow();
    const other = storeAt(join(root, 'private', 'b.json')); await other.load();
    expect(other.read().drafts).toEqual({});
  });
});
