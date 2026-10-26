import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertWorkspaceRelativePath,
  canonicalizeWorkspacePath,
  isPathOverlap,
  isWithin,
  WorkspacePathError,
} from '../../src/workspace/workspace-path.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'workspace-path-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('workspace path canonicalization', () => {
  it('collapses trailing slashes and symlink aliases into one identity', async () => {
    const alias = `${root}-alias`;
    await symlink(root, alias);
    try {
      const direct = await canonicalizeWorkspacePath(root);
      const trailing = await canonicalizeWorkspacePath(`${root}/`);
      const throughAlias = await canonicalizeWorkspacePath(alias);
      expect(trailing.canonicalPath).toBe(direct.canonicalPath);
      expect(throughAlias.canonicalPath).toBe(direct.canonicalPath);
      expect(direct.device).toMatch(/\d/u);
    } finally {
      await rm(alias, { force: true });
    }
  });

  it('rejects relative, missing, non-directory and filesystem-root inputs', async () => {
    await writeFile(join(root, 'file.txt'), 'x');
    await expect(canonicalizeWorkspacePath('relative/path'))
      .rejects.toMatchObject({ code: 'not_absolute' });
    await expect(canonicalizeWorkspacePath(join(root, 'missing')))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(canonicalizeWorkspacePath(join(root, 'file.txt')))
      .rejects.toMatchObject({ code: 'not_directory' });
    await expect(canonicalizeWorkspacePath('/'))
      .rejects.toMatchObject({ code: 'unsupported_root' });
  });

  it('reports path overlap for ancestors and descendants only', () => {
    expect(isPathOverlap('/Users/me/project', '/Users/me/project/sub', { caseSensitive: true })).toBe(true);
    expect(isPathOverlap('/Users/me/project/sub', '/Users/me/project', { caseSensitive: true })).toBe(true);
    expect(isPathOverlap('/Users/me/project', '/Users/me/project-other', { caseSensitive: true })).toBe(false);
    expect(isPathOverlap('/Users/me/Project', '/Users/me/project', { caseSensitive: false })).toBe(true);
    expect(isPathOverlap('/Users/me/Project', '/Users/me/project', { caseSensitive: true })).toBe(false);
    expect(() => isPathOverlap('relative', '/Users/me/project'))
      .toThrow(WorkspacePathError);
  });

  it('detects containment on segment boundaries', () => {
    expect(isWithin('/Users/me/project', '/Users/me/project')).toBe(true);
    expect(isWithin('/Users/me/project', '/Users/me/project/out/deck.pptx')).toBe(true);
    expect(isWithin('/Users/me/project', '/Users/me/project-other/deck.pptx')).toBe(false);
  });
});

describe('workspace relative file resolution', () => {
  it('resolves a regular file inside the workspace', async () => {
    await mkdir(join(root, 'out'), { recursive: true });
    await writeFile(join(root, 'out', 'deck.pptx'), 'pptx');
    const canonical = await canonicalizeWorkspacePath(root);
    const resolved = await assertWorkspaceRelativePath(root, 'out/deck.pptx');
    expect(resolved.relativePath).toBe('out/deck.pptx');
    expect(resolved.size).toBe(4);
    expect(resolved.absolutePath.startsWith(canonical.canonicalPath)).toBe(true);
  });

  it('rejects absolute input and traversal', async () => {
    await expect(assertWorkspaceRelativePath(root, '/etc/passwd'))
      .rejects.toMatchObject({ code: 'not_absolute' });
    await expect(assertWorkspaceRelativePath(root, '../escape.txt'))
      .rejects.toMatchObject({ code: 'escape' });
    await expect(assertWorkspaceRelativePath(root, 'out/../../escape.txt'))
      .rejects.toMatchObject({ code: 'escape' });
    await expect(assertWorkspaceRelativePath(root, 'out//deck.pptx'))
      .rejects.toMatchObject({ code: 'escape' });
  });

  it('rejects symlinked files and directories', async () => {
    await mkdir(join(root, 'out'), { recursive: true });
    await writeFile(join(root, 'out', 'real.txt'), 'x');
    await symlink(join(root, 'out', 'real.txt'), join(root, 'out', 'link.txt'));
    await expect(assertWorkspaceRelativePath(root, 'out/link.txt'))
      .rejects.toMatchObject({ code: 'symlink' });
    await mkdir(join(root, 'dir'), { recursive: true });
    await expect(assertWorkspaceRelativePath(root, 'dir'))
      .rejects.toMatchObject({ code: 'not_regular_file' });
  });

  it('rejects a symlinked parent that escapes the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'workspace-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(outside, join(root, 'escape'));
      await expect(assertWorkspaceRelativePath(root, 'escape/secret.txt'))
        .rejects.toMatchObject({ code: 'escape' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reports missing files distinctly from escapes', async () => {
    await expect(assertWorkspaceRelativePath(root, 'missing.txt'))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});
