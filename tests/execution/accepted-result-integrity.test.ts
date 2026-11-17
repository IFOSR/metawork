import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { ExecutorAttemptRuntimeRepo } from '../../src/storage/executor-attempt-runtime-repo.js';
import { WorkspaceGitService } from '../../src/execution/workspace-git-service.js';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';
import { SubtaskAttemptRunner } from '../../src/execution/subtask-attempt-runner.js';
import { captureWorkspaceState, deriveWorkspaceDelta, parseWorkspaceDelta, type WorkspaceDelta } from '../../src/execution/workspace-change-tracker.js';

describe('accepted result sealed file integrity', () => {
  it.each(['unchanged', 'modified', 'missing', 'forged_hash'] as const)(
    'validates a historical result containing temporary inputs (%s)', async mode => {
      const directory = await mkdtemp(join(tmpdir(), 'metawork-accepted-seal-'));
      const db = new Database(':memory:');
      try {
        initializeDatabaseSchema(db);
        const userRoot = join(directory, 'user');
        await mkdir(userRoot);
        await writeFile(join(userRoot, 'report.md'), 'before');
        const git = new WorkspaceGitService({ internalRoot: join(directory, 'runtime') });
        const root = await git.initialize({ accountId: 'account', workspaceId: 'workspace', userRoot });
        const worktree = await git.ensureConversation(root, 'conversation');
        const baseline = captureWorkspaceState(worktree.rootPath);
        const reportPath = join(worktree.rootPath, 'report.md');
        await writeFile(reportPath, 'accepted report');
        const scratch = '.metawork-tmp/attempt/inputs/upstream.md';
        await mkdir(join(worktree.rootPath, '.metawork-tmp/attempt/inputs'), { recursive: true });
        await writeFile(join(worktree.rootPath, scratch), 'upstream input');
        const current = deriveWorkspaceDelta(baseline, captureWorkspaceState(worktree.rootPath));
        const historical = { ...current, changed: [...current.changed, {
          path: scratch, beforeHash: null, afterHash: createHash('sha256').update('upstream input').digest('hex'),
        }] };
        const sealed = await git.seal(worktree, 'attempt');
        await rm(join(worktree.rootPath, '.metawork-tmp'), { recursive: true });
        const runtime = new ExecutorAttemptRuntimeRepo(db);
        runtime.start({ attemptId: 'attempt', sourceAttemptId: null, workspaceRoot: worktree.rootPath,
          recoverySafety: 'workspace_reconcilable', now: 'now' });
        runtime.recordWorkspaceDelta('attempt', historical, 'now');
        db.prepare('UPDATE executor_attempt_runtime SET before_commit=?, after_commit=? WHERE attempt_id=?')
          .run(worktree.headCommit, sealed.commit, 'attempt');
        const runner = new SubtaskAttemptRunner({ db, resultRoot: join(directory, 'results'),
          workspaceStore: new WorkspaceStore(join(directory, 'store')), subtaskRepo: new SubtaskRepo(db),
          conversationWorktrees: { git, repo: { root: () => root } },
        } as never);
        const delta = parseWorkspaceDelta(runtime.find('attempt')!.workspaceDelta)!;
        if (mode === 'modified') await writeFile(reportPath, 'later edit');
        if (mode === 'missing') await rm(reportPath);
        if (mode === 'forged_hash') delta.changed[0]!.afterHash = 'wrong';
        const check = (runner as unknown as { assertSealedDelta(input: {
          attemptId: string; workspaceId: string; delta: WorkspaceDelta; rootPath: string;
        }): Promise<void> }).assertSealedDelta({ attemptId: 'attempt', workspaceId: 'workspace', delta, rootPath: worktree.rootPath });
        if (mode === 'unchanged') await expect(check).resolves.toBeUndefined();
        else await expect(check).rejects.toThrow(/文件已变化|封存后已被修改/u);
        // The old observation remains immutable, including its two-file shape.
        expect(runtime.find('attempt')!.workspaceDelta).toEqual(historical);
      } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
    },
  );
});
