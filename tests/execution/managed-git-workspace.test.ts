import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedGitWorkspaceService } from '../../src/execution/managed-git-workspace.js';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';

const exec = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('ManagedGitWorkspaceService', () => {
  it('captures a dirty baseline and commits only to the managed branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metaclaw-managed-git-'));
    roots.push(root);
    const source = join(root, 'source');
    const store = new WorkspaceStore(join(root, 'store'));
    await exec('git', ['init', source]);
    await git(source, 'config', 'user.name', 'Test User');
    await git(source, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(source, 'tracked.txt'), 'base\n');
    await git(source, 'add', 'tracked.txt');
    await git(source, 'commit', '-m', 'base');
    const originalHead = await git(source, 'rev-parse', 'HEAD');
    const originalRefs = await git(source, 'show-ref');
    await writeFile(join(source, 'tracked.txt'), 'dirty baseline\n');
    await writeFile(join(source, 'untracked.txt'), 'untracked baseline\n');

    const service = new ManagedGitWorkspaceService(store);
    const workspace = await service.ensure({ taskId: 'task-1', generationId: 'generation-1', subtaskId: 'subtask-1' }, source);
    expect(workspace).not.toBeNull();
    expect(await readFile(join(workspace!.filesPath, 'tracked.txt'), 'utf8')).toBe('dirty baseline\n');
    expect(await readFile(join(workspace!.filesPath, 'untracked.txt'), 'utf8')).toBe('untracked baseline\n');
    await writeFile(join(workspace!.filesPath, 'result.txt'), 'executor result\n');
    const result = await service.commit(workspace!, 'feat: capture result');

    expect(result.branch).toBe('metaclaw/task-1/generation-1/subtask-1');
    expect(await git(workspace!.repositoryPath, 'rev-parse', result.branch)).toBe(result.commit);
    expect(await git(source, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(await git(source, 'show-ref')).toBe(originalRefs);
    expect(await git(source, 'status', '--porcelain')).toContain('tracked.txt');
  });

  it('composes only explicit direct dependency commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metaclaw-managed-deps-'));
    roots.push(root);
    const source = join(root, 'source');
    const store = new WorkspaceStore(join(root, 'store'));
    await exec('git', ['init', source]);
    await git(source, 'config', 'user.name', 'Test User');
    await git(source, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(source, 'base.txt'), 'base\n');
    await git(source, 'add', '.');
    await git(source, 'commit', '-m', 'base');
    const service = new ManagedGitWorkspaceService(store);
    const dependency = (await service.ensure({ taskId: 'task', generationId: 'gen', subtaskId: 'dep' }, source))!;
    await writeFile(join(dependency.filesPath, 'dependency.txt'), 'versioned state\n');
    const dependencyResult = await service.commit(dependency, 'feat: dependency');
    const downstream = (await service.ensure({ taskId: 'task', generationId: 'gen', subtaskId: 'downstream' }, source))!;
    await service.applyDependencyStates(downstream, [dependencyResult.commit]);

    expect((await readFile(join(downstream.filesPath, 'dependency.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe('versioned state\n');
  });
});
