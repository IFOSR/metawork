import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceDirectoryBrowser } from '../../src/management/workspace-directory-browser.js';
import {
  createWorkspaceDirectory,
  WorkspaceDirectoryCreateError,
} from '../../src/workspace/workspace-directory-creator.js';
import {
  isWithinWorkspaceRoot,
  resolveWorkspaceRoot,
  WorkspaceRootError,
} from '../../src/workspace/workspace-root.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workspace-root-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(workspaceRoot);
  await mkdir(outside);
  await mkdir(join(workspaceRoot, 'project'));
  return { root, workspaceRoot, outside };
}

describe('resolveWorkspaceRoot', () => {
  it('returns null when the environment does not configure a root', async () => {
    expect(await resolveWorkspaceRoot({})).toBeNull();
  });

  it('rejects a root that does not exist', async () => {
    const { root } = await fixture();
    await expect(resolveWorkspaceRoot({ METAWORK_WORKSPACE_ROOT: join(root, 'missing') }))
      .rejects.toBeInstanceOf(WorkspaceRootError);
  });

  it('rejects a relative root', async () => {
    await expect(resolveWorkspaceRoot({ METAWORK_WORKSPACE_ROOT: 'relative/path' }))
      .rejects.toBeInstanceOf(WorkspaceRootError);
  });

  it('rejects a root that is not a directory', async () => {
    const { root } = await fixture();
    const file = join(root, 'file.txt');
    await (await import('node:fs/promises')).writeFile(file, 'x');
    await expect(resolveWorkspaceRoot({ METAWORK_WORKSPACE_ROOT: file }))
      .rejects.toBeInstanceOf(WorkspaceRootError);
  });

  it('resolves the canonical path of a configured root', async () => {
    const { workspaceRoot } = await fixture();
    const resolved = await resolveWorkspaceRoot({ METAWORK_WORKSPACE_ROOT: workspaceRoot });
    expect(resolved).not.toBeNull();
    expect(resolved!.endsWith('workspace')).toBe(true);
  });
});

describe('isWithinWorkspaceRoot', () => {
  it('allows everything when no root is configured', () => {
    expect(isWithinWorkspaceRoot(null, '/anywhere')).toBe(true);
  });

  it('accepts the root itself and its descendants', () => {
    // 边界比较使用平台分隔符：生产路径全部来自 realpath()，与平台一致。
    const root = join(tmpdir(), 'root');
    expect(isWithinWorkspaceRoot(root, root)).toBe(true);
    expect(isWithinWorkspaceRoot(root, join(root, 'child'))).toBe(true);
    expect(isWithinWorkspaceRoot(root, join(root, 'child', 'deep'))).toBe(true);
  });

  it('rejects siblings and parents', () => {
    const root = join(tmpdir(), 'root');
    expect(isWithinWorkspaceRoot(root, `${root}less`)).toBe(false);
    expect(isWithinWorkspaceRoot(root, join(tmpdir(), 'other'))).toBe(false);
    expect(isWithinWorkspaceRoot(root, join(tmpdir(), '..'))).toBe(false);
  });
});

describe('WorkspaceDirectoryBrowser with a configured root', () => {
  it('starts at the root and reports no parent there', async () => {
    const { workspaceRoot } = await fixture();
    const browser = new WorkspaceDirectoryBrowser({ workspaceRoot: () => workspaceRoot });
    const result = await browser.browse();
    expect(result.path).toBe(await realpathOf(workspaceRoot));
    expect(result.parent).toBeNull();
    expect(result.root).toBe(await realpathOf(workspaceRoot));
    expect(result.crumbs[0]!.path).toBe(await realpathOf(workspaceRoot));
  });

  it('refuses to browse outside the root', async () => {
    const { workspaceRoot, outside } = await fixture();
    const browser = new WorkspaceDirectoryBrowser({ workspaceRoot: () => workspaceRoot });
    await expect(browser.browse(outside)).rejects.toThrow('browse_path_forbidden');
  });

  it('refuses a symlink that points outside the root', async () => {
    const { workspaceRoot, outside } = await fixture();
    const link = join(workspaceRoot, 'escape');
    await symlink(outside, link, 'dir');
    const browser = new WorkspaceDirectoryBrowser({ workspaceRoot: () => workspaceRoot });
    const result = await browser.browse();
    expect(result.entries.some(entry => entry.name === 'escape')).toBe(false);
  });

  it('keeps the unrestricted behaviour when no root is configured', async () => {
    const { root } = await fixture();
    const browser = new WorkspaceDirectoryBrowser({ defaultPath: () => root });
    const result = await browser.browse();
    expect(result.root).toBeNull();
    expect(result.parent).not.toBeNull();
  });
});

describe('createWorkspaceDirectory', () => {
  it('creates a single directory inside the root and returns its canonical path', async () => {
    const { workspaceRoot } = await fixture();
    const created = await createWorkspaceDirectory(
      { parentPath: workspaceRoot, name: 'new-project' },
      { workspaceRoot: await realpathOf(workspaceRoot) },
    );
    expect(created.name).toBe('new-project');
    expect(created.path.endsWith('new-project')).toBe(true);
    const listed = await createWorkspaceDirectory(
      { parentPath: workspaceRoot, name: 'new-project' },
      { workspaceRoot: await realpathOf(workspaceRoot) },
    ).catch(error => error as WorkspaceDirectoryCreateError);
    expect(listed).toBeInstanceOf(WorkspaceDirectoryCreateError);
    expect((listed as WorkspaceDirectoryCreateError).code).toBe('directory_exists');
  });

  it('refuses a parent outside the root', async () => {
    const { workspaceRoot, outside } = await fixture();
    await expect(createWorkspaceDirectory(
      { parentPath: outside, name: 'nope' },
      { workspaceRoot: await realpathOf(workspaceRoot) },
    )).rejects.toBeInstanceOf(WorkspaceDirectoryCreateError);
  });

  it('refuses names that could escape the parent', async () => {
    const { workspaceRoot } = await fixture();
    const root = await realpathOf(workspaceRoot);
    for (const name of ['..', '.', 'a/b', 'a\\b', '', '   ']) {
      await expect(createWorkspaceDirectory({ parentPath: workspaceRoot, name }, { workspaceRoot: root }))
        .rejects.toBeInstanceOf(WorkspaceDirectoryCreateError);
    }
  });

  it('reports a missing parent directory', async () => {
    const { workspaceRoot, root } = await fixture();
    await expect(createWorkspaceDirectory(
      { parentPath: join(root, 'missing'), name: 'child' },
      { workspaceRoot: await realpathOf(workspaceRoot) },
    )).rejects.toMatchObject({ code: 'directory_parent_not_found' });
  });
});

async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(path);
}
