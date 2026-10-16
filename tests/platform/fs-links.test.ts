import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDirectoryLink,
  directoryLinkReplacementIsAtomic,
  readDirectoryLinkTarget,
  replaceDirectoryLink,
} from '../../src/platform/fs-links.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'metawork-fs-links-'));
  roots.push(root);
  await mkdir(join(root, 'revisions', 'revision-1'), { recursive: true });
  await writeFile(join(root, 'revisions', 'revision-1', 'config.yaml'), 'schemaVersion: 2\n');
  await mkdir(join(root, 'revisions', 'revision-2'), { recursive: true });
  await writeFile(join(root, 'revisions', 'revision-2', 'config.yaml'), 'schemaVersion: 2\n');
  return root;
}

describe('directory links', () => {
  it('reads back the relative target the pointer contract stores', async () => {
    const root = await fixture();
    const link = join(root, 'active');

    await createDirectoryLink(link, join('revisions', 'revision-1'));

    expect(await readDirectoryLinkTarget(link)).toBe('revisions/revision-1');
    expect(await readFile(join(link, 'config.yaml'), 'utf8')).toContain('schemaVersion: 2');
  });

  it('replaces an existing pointer without removing the revision it pointed at', async () => {
    const root = await fixture();
    const link = join(root, 'active');

    await createDirectoryLink(link, join('revisions', 'revision-1'));
    await replaceDirectoryLink(link, join('revisions', 'revision-2'));

    expect(await readDirectoryLinkTarget(link)).toBe('revisions/revision-2');
    expect(await readFile(join(root, 'revisions', 'revision-1', 'config.yaml'), 'utf8'))
      .toContain('schemaVersion: 2');
    expect(await readFile(join(link, 'config.yaml'), 'utf8')).toContain('schemaVersion: 2');
  });

  it('reports whether replacement is a single atomic rename', () => {
    // POSIX renames the new link over the old one; Windows must remove first.
    expect(directoryLinkReplacementIsAtomic).toBe(process.platform !== 'win32');
  });

  it('refuses to treat a plain directory as a pointer', async () => {
    const root = await fixture();

    await expect(readDirectoryLinkTarget(join(root, 'revisions'))).rejects.toThrow();
  });
});
