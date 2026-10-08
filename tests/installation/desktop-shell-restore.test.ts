import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { restoreDesktopApplication } from '../../src/installation/desktop-shell-restore.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-shell-restore-')); roots.push(root);
  const record = { applicationPath: join(root, 'MetaWork.app'), backupApplicationPath: join(root, 'MetaWork.app.backup') };
  await mkdir(record.backupApplicationPath);
  await writeFile(join(record.backupApplicationPath, 'bundle'), 'original');
  return { root, record };
}

it('restores the original without leaving a failed or staged application', async () => {
  const { root, record } = await fixture();
  await mkdir(record.applicationPath);
  await writeFile(join(record.applicationPath, 'bundle'), 'failed candidate');
  await mkdir(`${record.applicationPath}.metawork-staged`);
  await writeFile(join(root, 'account-data'), 'preserve');
  await restoreDesktopApplication(record);
  expect(await readdir(root)).toEqual(['MetaWork.app', 'account-data']);
  expect(await readFile(join(record.applicationPath, 'bundle'), 'utf8')).toBe('original');
  expect(await readFile(join(root, 'account-data'), 'utf8')).toBe('preserve');
});

it('recovers an interruption after candidate removal and preserves the result on retry', async () => {
  const { root, record } = await fixture();
  await restoreDesktopApplication(record);
  await restoreDesktopApplication(record);
  expect(await readdir(root)).toEqual(['MetaWork.app']);
  expect(await readFile(join(record.applicationPath, 'bundle'), 'utf8')).toBe('original');
});

it('does not remove the installed app when shell replacement never created a backup', async () => {
  const { record } = await fixture();
  await rm(record.backupApplicationPath, { recursive: true });
  await mkdir(record.applicationPath);
  await writeFile(join(record.applicationPath, 'bundle'), 'untouched');
  await restoreDesktopApplication(record);
  expect(await readFile(join(record.applicationPath, 'bundle'), 'utf8')).toBe('untouched');
});
