import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopPreferenceStore, desktopPreferencePath } from '../main/preferences.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('Desktop account preferences', () => {
  it('opens and saves alongside Chromium Preferences, including case-insensitive filesystems', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-preferences-')); roots.push(root);
    await writeFile(join(root, 'Preferences'), '{"chromium":true}');
    const store = new DesktopPreferenceStore(await desktopPreferencePath(root, 'installation', 'account'));
    await store.load();
    await store.setTheme('dark');
    expect(await readFile(join(root, 'Preferences'), 'utf8')).toBe('{"chromium":true}');
    expect(JSON.parse(await readFile(join(root, 'account-preferences/installation/account.json'), 'utf8')).theme).toBe('dark');
  });
  it('retains historical account drafts without overwriting newer preferences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-preferences-')); roots.push(root);
    const legacy = new DesktopPreferenceStore(join(root, 'preferences/installation/account.json'));
    await legacy.setDraft('conversation', { text: 'existing draft', attachments: [] });
    const path = await desktopPreferencePath(root, 'installation', 'account');
    const current = new DesktopPreferenceStore(path); await current.load();
    expect(current.read().drafts.conversation.text).toBe('existing draft');
    await current.setDraft('conversation', { text: 'newer draft', attachments: [] });
    await writeFile(join(root, 'Preferences'), '{"chromium":true}');
    await desktopPreferencePath(root, 'installation', 'account');
    await current.load();
    expect(current.read().drafts.conversation.text).toBe('newer draft');
    expect(await readFile(join(root, 'Preferences'), 'utf8')).toBe('{"chromium":true}');
  });
  it('persists the latest concurrent draft atomically and restores independent of port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-preferences-')); roots.push(root);
    const path = join(root, 'installation/account.json');
    const store = new DesktopPreferenceStore(path); await store.load();
    await Promise.all(Array.from({ length: 80 }, (_, n) => store.setDraft('conversation', { text: `edit ${n}`, attachments: [] })));
    const restored = new DesktopPreferenceStore(path); await restored.load();
    expect(restored.read().drafts.conversation.text).toBe('edit 79');
    expect((await stat(path)).mode & 0o077).toBe(0);
    await restored.clearDrafts();
    expect(JSON.parse(await readFile(path, 'utf8')).drafts).toEqual({});
  });
  it('rejects oversized drafts without changing saved user work and scopes accounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-preferences-')); roots.push(root);
    const store = new DesktopPreferenceStore(join(root, 'a.json'));
    await store.setDraft('conversation', { text: '保留', attachments: [] });
    await expect(store.setDraft('conversation', { text: 'x'.repeat(50000), attachments: [] })).rejects.toThrow();
    expect(store.read().drafts.conversation.text).toBe('保留');
    await expect(store.setDraft('__proto__', { text: '', attachments: [] })).rejects.toThrow();
    const other = new DesktopPreferenceStore(join(root, 'b.json')); await other.load();
    expect(other.read().drafts).toEqual({});
  });
});
