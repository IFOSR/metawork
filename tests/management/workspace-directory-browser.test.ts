import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, parse } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceDirectoryBrowser } from '../../src/management/workspace-directory-browser.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workspace-browser-'));
  roots.push(root);
  for (const name of ['zeta', 'alpha', 'Beta']) {
    await mkdir(join(root, name));
  }
  await writeFile(join(root, 'notes.txt'), 'not a directory');
  await symlink(join(root, 'alpha'), join(root, 'linked-alpha'));
  await symlink(join(root, 'notes.txt'), join(root, 'linked-file'));
  return root;
}

describe('WorkspaceDirectoryBrowser', () => {
  it('lists directories only, sorted, under canonical paths', async () => {
    const root = await fixture();
    const canonicalRoot = await realpath(root);
    const browser = new WorkspaceDirectoryBrowser();

    const result = await browser.browse(root);

    expect(result.path).toBe(canonicalRoot);
    expect(result.entries.map(entry => entry.name)).toEqual([
      'alpha',
      'Beta',
      'linked-alpha',
      'zeta',
    ]);
    // 每个 entry 的 path 都是 realpath：符号链接报告其目标目录的规范路径。
    for (const entry of result.entries) {
      expect(entry.path).toBe(await realpath(join(result.path, entry.name)));
      expect(entry.path.startsWith(result.path)).toBe(true);
    }
    expect(result.entries.find(entry => entry.name === 'linked-alpha')?.path)
      .toBe(join(canonicalRoot, 'alpha'));
    expect(result.entries.map(entry => entry.name)).not.toContain('notes.txt');
    expect(result.entries.map(entry => entry.name)).not.toContain('linked-file');
  });

  it('returns Server-built crumbs so clients never parse an OS path', async () => {
    const root = await fixture();
    const browser = new WorkspaceDirectoryBrowser();

    const result = await browser.browse(root);

    expect(result.crumbs[0]).toEqual({
      name: parse(result.path).root,
      path: parse(result.path).root,
    });
    expect(result.crumbs.at(-1)).toEqual({
      name: basename(result.path),
      path: result.path,
    });
    // 每一级都是上一级的直接子目录。
    for (let index = 1; index < result.crumbs.length; index += 1) {
      const previous = result.crumbs[index - 1]!;
      const current = result.crumbs[index]!;
      expect(current.path).toBe(join(previous.path, current.name));
      expect(current.path.startsWith(previous.path)).toBe(true);
    }
  });

  it('reports the parent directory and clamps the filesystem root', async () => {
    const browser = new WorkspaceDirectoryBrowser();
    const root = await browser.browse('/');

    expect(root.path).toBe('/');
    expect(root.parent).toBeNull();
  });

  it('returns the default path when no path is requested', async () => {
    const root = await fixture();
    const browser = new WorkspaceDirectoryBrowser({ defaultPath: () => root });

    await expect(browser.browse()).resolves.toMatchObject({ path: await realpath(root) });
  });

  it('caps the number of returned entries', async () => {
    const root = await fixture();
    const browser = new WorkspaceDirectoryBrowser({ maxEntries: 2 });

    const result = await browser.browse(root);

    expect(result.entries).toHaveLength(2);
  });

  it('rejects relative, missing, and non-directory paths', async () => {
    const root = await fixture();
    const browser = new WorkspaceDirectoryBrowser();

    await expect(browser.browse('relative/path')).rejects.toThrow('browse_path_invalid');
    await expect(browser.browse(join(root, 'missing'))).rejects.toThrow('browse_path_not_found');
    await expect(browser.browse(join(root, 'notes.txt'))).rejects.toThrow('browse_path_invalid');
  });
});
