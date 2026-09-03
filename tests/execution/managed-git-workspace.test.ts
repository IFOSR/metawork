import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('imports plain sources containing executor sockets without failing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metaclaw-managed-git-socket-'));
    roots.push(root);
    const source = join(root, 'source');
    await mkdir(join(source, '.agent-browser'), { recursive: true });
    await writeFile(join(source, 'weather.md'), 'sunny\n');
    const sockPath = join(source, '.agent-browser', 'default.sock');
    const server = createServer();
    await new Promise<void>(resolve => server.listen(sockPath, resolve));

    try {
      const service = new ManagedGitWorkspaceService(new WorkspaceStore(join(root, 'store')));
      const workspace = await service.ensure(
        { taskId: 'task-socket', generationId: 'generation-socket', subtaskId: 'subtask-socket' },
        source,
      );
      expect(workspace).not.toBeNull();
      expect(await readFile(join(workspace!.filesPath, 'weather.md'), 'utf8')).toBe('sunny\n');
      expect(existsSync(join(workspace!.filesPath, '.agent-browser', 'default.sock'))).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

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

  it('reuses one immutable dirty baseline for every workspace in a generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metaclaw-managed-shared-baseline-'));
    roots.push(root);
    const source = join(root, 'source');
    const store = new WorkspaceStore(join(root, 'store'));
    await exec('git', ['init', source]);
    await git(source, 'config', 'user.name', 'Test User');
    await git(source, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(source, 'tracked.txt'), 'committed\n');
    await git(source, 'add', '.');
    await git(source, 'commit', '-m', 'base');
    await writeFile(join(source, 'tracked.txt'), 'generation baseline\n');
    await writeFile(join(source, 'baseline-only.txt'), 'captured once\n');

    const service = new ManagedGitWorkspaceService(store);
    const first = await service.ensure({
      taskId: 'task-shared-baseline',
      generationId: 'generation-shared-baseline',
      subtaskId: 'first',
    }, source);
    await writeFile(join(source, 'tracked.txt'), 'later source drift\n');
    await writeFile(join(source, 'late-only.txt'), 'must not enter the generation\n');
    const second = await service.ensure({
      taskId: 'task-shared-baseline',
      generationId: 'generation-shared-baseline',
      subtaskId: 'second',
    }, source);

    expect(second.baselineCommit).toBe(first.baselineCommit);
    expect(second.sourceDiffHash).toBe(first.sourceDiffHash);
    expect(await readFile(join(second.filesPath, 'tracked.txt'), 'utf8'))
      .toBe('generation baseline\n');
    expect(await readFile(join(second.filesPath, 'baseline-only.txt'), 'utf8'))
      .toBe('captured once\n');
    await expect(readFile(join(second.filesPath, 'late-only.txt'), 'utf8')).rejects.toThrow();
  });

  it('publishes only the candidate commit delta when a legacy baseline has divergent source drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metaclaw-managed-candidate-delta-'));
    roots.push(root);
    const source = join(root, 'source');
    const store = new WorkspaceStore(join(root, 'store'));
    await exec('git', ['init', source]);
    await git(source, 'config', 'user.name', 'Test User');
    await git(source, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(source, 'implementation.ts'), 'export const value = "base";\n');
    await git(source, 'add', '.');
    await git(source, 'commit', '-m', 'base');
    await writeFile(join(source, 'implementation.ts'), 'export const value = "integration";\n');

    const service = new ManagedGitWorkspaceService(store);
    const integration = await service.ensure({
      taskId: 'task-candidate-delta',
      generationId: 'generation-candidate-delta',
      subtaskId: '__integration__',
    }, source);
    const legacyCandidatePath = join(root, 'legacy-candidate');
    await exec('git', [
      '--git-dir', integration.repositoryPath,
      'worktree', 'add', '-b', 'legacy-candidate', legacyCandidatePath, integration.sourceCommit,
    ]);
    await git(legacyCandidatePath, 'config', 'user.name', 'Test User');
    await git(legacyCandidatePath, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(legacyCandidatePath, 'implementation.ts'), 'export const value = "candidate";\n');
    await git(legacyCandidatePath, 'add', '.');
    await git(legacyCandidatePath, 'commit', '-m', 'chore: capture divergent legacy baseline');
    await writeFile(join(legacyCandidatePath, 'report.html'), '<h1>candidate report</h1>\n');
    await git(legacyCandidatePath, 'add', '.');
    await git(legacyCandidatePath, 'commit', '-m', 'feat: add report artifact');
    const candidateCommit = await git(legacyCandidatePath, 'rev-parse', 'HEAD');

    await expect(service.mergeCandidate(integration, candidateCommit)).resolves.toMatchObject({
      type: 'integrated',
      changedPaths: ['report.html'],
    });
    expect(await readFile(join(integration.filesPath, 'implementation.ts'), 'utf8'))
      .toBe('export const value = "integration";\n');
    expect(await readFile(join(integration.filesPath, 'report.html'), 'utf8'))
      .toBe('<h1>candidate report</h1>\n');
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
    await writeFile(join(dependency.filesPath, 'ancestor.txt'), 'dependency ancestor\n');
    const ancestor = await service.commit(dependency, 'feat: dependency ancestor');
    await writeFile(join(dependency.filesPath, 'dependency.txt'), 'versioned state\n');
    const dependencyResult = await service.commit(dependency, 'feat: dependency');
    const downstream = (await service.ensure({ taskId: 'task', generationId: 'gen', subtaskId: 'downstream' }, source))!;
    await service.applyDependencyStates(downstream, [dependencyResult.commit]);

    expect((await readFile(join(downstream.filesPath, 'dependency.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe('versioned state\n');
    await expect(git(downstream.filesPath, 'merge-base', '--is-ancestor', ancestor.commit, 'HEAD'))
      .resolves.toBe('');
  });

  it('imports a non-Git source into the same managed bare-repository shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metaclaw-managed-import-'));
    roots.push(root);
    const source = join(root, 'plain-source');
    const store = new WorkspaceStore(join(root, 'store'));
    await exec('git', ['init', source]);
    await rm(join(source, '.git'), { recursive: true, force: true });
    await writeFile(join(source, 'plain.txt'), 'immutable initial snapshot\n');

    const service = new ManagedGitWorkspaceService(store);
    const workspace = await service.ensure({
      taskId: 'task-import',
      generationId: 'generation-import',
      subtaskId: 'subtask-import',
    }, source);

    expect(workspace.kind).toBe('git');
    expect((await readFile(join(workspace.filesPath, 'plain.txt'), 'utf8')).replaceAll('\r\n', '\n'))
      .toBe('immutable initial snapshot\n');
    expect(await git(workspace.filesPath, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    await expect(readFile(join(source, '.git'), 'utf8')).rejects.toThrow();
  });

  it('never auto-merges a concurrently modified binary-policy path even when its bytes look textual', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metaclaw-managed-binary-policy-'));
    roots.push(root);
    const source = join(root, 'source');
    const store = new WorkspaceStore(join(root, 'store'));
    await exec('git', ['init', source]);
    await git(source, 'config', 'user.name', 'Test User');
    await git(source, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(source, 'report.pdf'), 'title: base\nfooter: base\n');
    await git(source, 'add', '.');
    await git(source, 'commit', '-m', 'base');

    const service = new ManagedGitWorkspaceService(store);
    const integration = await service.ensure({
      taskId: 'task-binary', generationId: 'gen', subtaskId: '__integration__',
    }, source);
    const first = await service.ensure({
      taskId: 'task-binary', generationId: 'gen', subtaskId: 'first',
    }, source);
    const second = await service.ensure({
      taskId: 'task-binary', generationId: 'gen', subtaskId: 'second',
    }, source);
    await writeFile(join(first.filesPath, 'report.pdf'), 'title: first\nfooter: base\n');
    const firstCommit = await service.commit(first, 'feat: first binary candidate');
    await writeFile(join(second.filesPath, 'report.pdf'), 'title: base\nfooter: second\n');
    const secondCommit = await service.commit(second, 'feat: second binary candidate');

    await expect(service.mergeCandidate(integration, firstCommit.commit)).resolves.toMatchObject({
      type: 'integrated',
    });
    await expect(service.mergeCandidate(integration, secondCommit.commit)).resolves.toMatchObject({
      type: 'conflicted',
      conflictPaths: ['report.pdf'],
      filePolicy: { 'report.pdf': 'binary' },
    });
    expect((await readFile(join(integration.filesPath, 'report.pdf'), 'utf8')).replaceAll('\r\n', '\n'))
      .toBe('title: first\nfooter: base\n');
  });

  it('classifies text and binary conflicts and accepts a scoped repair merge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metaclaw-managed-repair-'));
    roots.push(root);
    const source = join(root, 'source');
    const store = new WorkspaceStore(join(root, 'store'));
    await exec('git', ['init', source]);
    await git(source, 'config', 'user.name', 'Test User');
    await git(source, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(source, '.gitattributes'), '*.bin binary\n');
    await writeFile(join(source, 'shared.txt'), 'base\n');
    await writeFile(join(source, 'asset.bin'), Buffer.from([0, 1, 2]));
    await git(source, 'add', '.');
    await git(source, 'commit', '-m', 'base');

    const service = new ManagedGitWorkspaceService(store);
    const integration = await service.ensure({
      taskId: 'task-repair', generationId: 'gen', subtaskId: '__integration__',
    }, source);
    const first = await service.ensure({
      taskId: 'task-repair', generationId: 'gen', subtaskId: 'first',
    }, source);
    const second = await service.ensure({
      taskId: 'task-repair', generationId: 'gen', subtaskId: 'second',
    }, source);
    await writeFile(join(first.filesPath, 'shared.txt'), 'first\n');
    await writeFile(join(first.filesPath, 'asset.bin'), Buffer.from([0, 3, 4]));
    const firstCommit = await service.commit(first, 'feat: first candidate');
    await writeFile(join(second.filesPath, 'shared.txt'), 'second\n');
    await writeFile(join(second.filesPath, 'asset.bin'), Buffer.from([0, 5, 6]));
    const secondCommit = await service.commit(second, 'feat: second candidate');

    await expect(service.mergeCandidate(integration, firstCommit.commit)).resolves.toMatchObject({
      type: 'integrated',
    });
    const conflict = await service.mergeCandidate(integration, secondCommit.commit);
    expect(conflict).toMatchObject({
      type: 'conflicted',
      conflictPaths: ['asset.bin', 'shared.txt'],
      filePolicy: {
        'asset.bin': 'binary',
        'shared.txt': 'text',
      },
    });
    if (conflict.type !== 'conflicted') throw new Error('expected the second candidate to conflict');

    const preparation = await service.prepareMergeRepair({
      candidateWorkspace: second,
      integrationWorkspace: integration,
      candidateCommit: secondCommit.commit,
      expectedConflictPaths: conflict.conflictPaths,
      filePolicy: conflict.filePolicy,
    });
    expect(preparation.conflictPaths).toEqual(['asset.bin', 'shared.txt']);
    expect(await readFile(join(preparation.materialsPath, 'asset.bin.ours'))).toEqual(Buffer.from([0, 5, 6]));
    const repeatedPreparation = await service.prepareMergeRepair({
      candidateWorkspace: second,
      integrationWorkspace: integration,
      candidateCommit: secondCommit.commit,
      expectedConflictPaths: conflict.conflictPaths,
      filePolicy: conflict.filePolicy,
    });
    expect(repeatedPreparation.conflictPaths).toEqual(['asset.bin', 'shared.txt']);
    expect(await readFile(join(repeatedPreparation.materialsPath, 'asset.bin.ours')))
      .toEqual(Buffer.from([0, 5, 6]));
    await writeFile(join(second.filesPath, 'shared.txt'), 'resolved\n');
    await writeFile(join(second.filesPath, 'asset.bin'), Buffer.from([0, 7, 8]));
    const repaired = await service.commitMergeRepair({
      workspace: second,
      allowedPaths: conflict.conflictPaths,
      filePolicy: conflict.filePolicy,
      reportedResolvedPaths: ['shared.txt', 'asset.bin'],
    });
    expect(repaired.workspaceCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(await git(second.filesPath, 'rev-parse', 'HEAD')).toBe(repaired.workspaceCommit);
    await expect(git(
      second.filesPath,
      'merge-base',
      '--is-ancestor',
      firstCommit.commit,
      repaired.workspaceCommit,
    )).rejects.toThrow();
    const integrated = await service.mergeCandidate(integration, repaired.commit);

    expect(integrated.type).toBe('integrated');
    expect((await readFile(join(integration.filesPath, 'shared.txt'), 'utf8')).replaceAll('\r\n', '\n'))
      .toBe('resolved\n');
    expect(await readFile(join(integration.filesPath, 'asset.bin'))).toEqual(Buffer.from([0, 7, 8]));
    expect(await git(source, 'status', '--porcelain')).toBe('');
  }, 600_000);
});
