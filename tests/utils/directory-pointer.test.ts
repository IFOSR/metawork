import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDirectorySymlink,
  createFilePointer,
  renameOverPointer,
  restoreWriteAccess,
} from '../../src/utils/directory-pointer.js';

const roots: string[] = [];
afterEach(() => {
  const pending = roots.splice(0).map(root => rm(root, { recursive: true, force: true }).then(() => undefined, () => undefined));
  return Promise.all(pending);
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'directory-pointer-'));
  roots.push(root);
  return root;
}

describe('createDirectorySymlink', () => {
  it.runIf(process.platform === 'win32')('creates an unprivileged junction whose readlink resolves to the target', async () => {
    const root = await fixture();
    const target = join(root, 'revisions', 'rev-1');
    await mkdir(target, { recursive: true });
    const linkPath = join(root, 'active');
    await createDirectorySymlink(join('revisions', 'rev-1'), linkPath, 'win32');

    // Junctions read back as absolute paths ending in the relative target.
    expect(await readlink(linkPath)).toContain('revisions');
    expect(await realpath(linkPath)).toBe(await realpath(target));
  });

  it.runIf(process.platform !== 'win32')('keeps the relative target form on POSIX', async () => {
    const root = await fixture();
    const target = join(root, 'revisions', 'rev-1');
    await mkdir(target, { recursive: true });
    const linkPath = join(root, 'active');
    await createDirectorySymlink(join('revisions', 'rev-1'), linkPath, 'linux');

    expect(await readlink(linkPath)).toBe(join('revisions', 'rev-1'));
    expect(await realpath(linkPath)).toBe(await realpath(target));
  });
});

describe('createFilePointer', () => {
  it('links a database file and reads through the pointer', async () => {
    const root = await fixture();
    await mkdir(join(root, 'database-revisions'), { recursive: true });
    await writeFile(join(root, 'database-revisions', 'rev-1.db'), 'sqlite');
    const pointer = join(root, 'database');
    await createFilePointer(join('database-revisions', 'rev-1.db'), pointer);

    expect(await readFile(pointer, 'utf8')).toBe('sqlite');
  });
});

describe('renameOverPointer', () => {
  it('swaps a directory pointer and consumes the temporary link', async () => {
    const root = await fixture();
    await mkdir(join(root, 'revisions', 'a'), { recursive: true });
    const pointer = join(root, 'active');
    const temporary = `${pointer}.next-${Date.now()}`;
    await createDirectorySymlink(join('revisions', 'a'), pointer);
    await createDirectorySymlink(join('revisions', 'a'), temporary);

    await renameOverPointer(temporary, pointer);

    const entries = await readdir(root);
    expect(entries).toContain('active');
    expect(entries.some(entry => entry.startsWith('active.next'))).toBe(false);
  });
});

describe('restoreWriteAccess', () => {
  it('clears read-only modes so a tree can be removed', async () => {
    const root = await fixture();
    await mkdir(join(root, 'nested'), { recursive: true });
    const file = join(root, 'nested', 'immutable.txt');
    await writeFile(file, 'x');
    await chmod(file, 0o444);
    await chmod(join(root, 'nested'), 0o555);

    await restoreWriteAccess(root);

    const info = await stat(file);
    expect(info.mode & 0o200).not.toBe(0);
    await rm(root, { recursive: true, force: true });
  });
});
