import { access, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { WorkspaceGitService } from '../../src/execution/workspace-git-service.js';

describe('private Workspace Git', () => {
  let directory: string;
  let userRoot: string;
  let service: WorkspaceGitService;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'metawork-git-'));
    userRoot = join(directory, 'user');
    await mkdir(userRoot);
    service = new WorkspaceGitService({ internalRoot: join(directory, 'runtime') });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const initialize = () => service.initialize({ accountId: 'a', workspaceId: 'w', userRoot });
  test('initializes empty directories and resumes initialization idempotently', async () => {
    const root = await initialize();
    expect(root.mainCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect((await initialize()).deliveredCommit).toBe(root.deliveredCommit);
    await expect(readFile(join(userRoot, '.git'))).rejects.toThrow();
    expect(await service.text(['-C', root.integrationPath, 'symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
  });
  test('isolates conversations, seals raw bytes and safely preserves link targets', async () => {
    await writeFile(join(userRoot, 'a.txt'), 'baseline\r\n');
    await symlink('a.txt', join(userRoot, 'link'));
    const root = await initialize();
    const [one, two] = await Promise.all([service.ensureConversation(root, 'c1'), service.ensureConversation(root, 'c2')]);
    await writeFile(join(one.rootPath, 'a.txt'), 'one');
    await writeFile(join(two.rootPath, 'b.txt'), 'two');
    const [first, second] = await Promise.all([service.seal(one, 'one'), service.seal(two, 'two')]);
    expect(first.changedPaths).toEqual(['a.txt']);
    expect(second.changedPaths).toEqual(['b.txt']);
    expect(await readFile(join(userRoot, 'a.txt'), 'utf8')).toBe('baseline\r\n');
    expect(await readFile(join(two.rootPath, 'a.txt'), 'utf8')).toBe('baseline\r\n');
    expect(await readlink(join(one.rootPath, 'link'))).toBe('a.txt');
  });
  test('respects ignore rules and excludes runtime/dependency and user Git metadata', async () => {
    await mkdir(join(userRoot, '.git')); await writeFile(join(userRoot, '.git', 'sentinel'), 'unchanged');
    await mkdir(join(userRoot, 'node_modules')); await writeFile(join(userRoot, 'node_modules', 'a'), 'skip');
    await writeFile(join(userRoot, '.gitignore'), '*.log\n'); await writeFile(join(userRoot, 'private.log'), 'skip');
    await writeFile(join(userRoot, 'keep.md'), 'keep');
    const root = await initialize();
    expect((await service.entries(root.repositoryPath, root.mainCommit)).map(e => e.path)).toEqual(['.gitignore', 'keep.md']);
    expect(await readFile(join(userRoot, '.git', 'sentinel'), 'utf8')).toBe('unchanged');
  });
  test('ignores user Git filters and global environment injection', async () => {
    await writeFile(join(userRoot, '.gitattributes'), '*.txt text eol=crlf filter=untrusted\n');
    await writeFile(join(userRoot, 'data.txt'), 'raw\r\n');
    const root = await initialize();
    const worktree = await service.ensureConversation(root, 'test');
    expect(await readFile(join(worktree.rootPath, 'data.txt'), 'utf8')).toBe('raw\r\n');
    const sealed = await service.seal(worktree, 'unchanged');
    expect(sealed.changedPaths).toEqual([]);
  });
  test('does not reset unsealed work or accept a foreign worktree', async () => {
    const root = await initialize(); const worktree = await service.ensureConversation(root, 'test');
    await writeFile(join(worktree.rootPath, 'draft.md'), 'draft');
    await expect(service.syncConversation(worktree)).rejects.toThrow('unsealed');
    await expect(service.validateWorktree({ ...worktree, rootPath: userRoot })).rejects.toThrow();
  });
  test('rejects capacity overflow with a concrete path', async () => {
    await writeFile(join(userRoot, 'large.txt'), '12345');
    service = new WorkspaceGitService({ internalRoot: join(directory, 'runtime'), maxFileBytes: 4 });
    await expect(initialize()).rejects.toThrow('large.txt');
  });
  test('uses a persistent source index and hashes only changed user files', async () => {
    await writeFile(join(userRoot, 'unchanged.md'), 'unchanged');
    await writeFile(join(userRoot, 'changed.md'), 'before');
    const root = await initialize();
    await expect(access(service.sourceIndexPath(root.repositoryPath))).resolves.toBeUndefined();
    const scan = vi.spyOn(service, 'scan');
    expect(await service.captureUserRoot(root.repositoryPath, userRoot, root.deliveredCommit, 'No external change')).toBe(root.deliveredCommit);
    expect(scan).not.toHaveBeenCalled();
    await writeFile(join(userRoot, 'changed.md'), 'after');
    const changed = await service.captureUserRoot(root.repositoryPath, userRoot, root.deliveredCommit, 'Capture one external change');
    expect(changed).not.toBe(root.deliveredCommit);
    expect((await service.entries(root.repositoryPath, changed)).map(entry => entry.path)).toEqual(['changed.md', 'unchanged.md']);
    scan.mockRestore();
  });
  test('keeps fixed runtime and dependency exclusions when discovering new files incrementally', async () => {
    const root = await initialize();
    await mkdir(join(userRoot, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(userRoot, 'node_modules', 'pkg', 'index.js'), 'dependency');
    await mkdir(join(userRoot, '.metawork-tmp'), { recursive: true });
    await writeFile(join(userRoot, '.metawork-tmp', 'scratch.txt'), 'scratch');
    const captured = await service.captureUserRoot(root.repositoryPath, userRoot, root.deliveredCommit, 'Ignore runtime files');
    expect(captured).toBe(root.deliveredCommit);
    expect(await service.entries(root.repositoryPath, captured)).toEqual([]);
  });
});
