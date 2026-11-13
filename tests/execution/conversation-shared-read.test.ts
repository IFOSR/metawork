import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { WorkspaceGitRepo } from '../../src/storage/workspace-git-repo.js';
import { WorkspaceGitService } from '../../src/execution/workspace-git-service.js';
import { ConversationWorktreeService } from '../../src/execution/conversation-worktree-service.js';
import { WorkspaceGitRecovery } from '../../src/execution/workspace-git-recovery.js';
import { WorkspaceMergeWorker } from '../../src/execution/workspace-merge-worker.js';

describe('durable shared read ownership and recovery', () => {
  let directory: string;
  let db: Database.Database;
  let repo: WorkspaceGitRepo;
  let git: WorkspaceGitService;
  let service: ConversationWorktreeService;
  let binding: Awaited<ReturnType<ConversationWorktreeService['bind']>>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'metawork-read-'));
    const userRoot = join(directory, 'user');
    await mkdir(userRoot);
    await writeFile(join(userRoot, 'input.txt'), 'before');
    db = new Database(join(directory, 'state.sqlite'));
    initializeDatabaseSchema(db);
    repo = new WorkspaceGitRepo(db);
    git = new WorkspaceGitService({internalRoot: join(directory, 'runtime')});
    service = new ConversationWorktreeService(git, repo);
    const task = new TaskEngine(new TaskRepo(db), join(directory, 'snapshots')).create({
      title: 'mixed', goal: 'mixed', accountId: 'a', conversationId: 'c', workspaceId: 'w',
    });
    binding = await service.bind({accountId: 'a', workspaceId: 'w', conversationId: 'c', userRoot,
      taskId: task.id, generationId: 'g'});
  });
  afterEach(async () => { db.close(); await rm(directory, {recursive: true, force: true}); });
  const claim = (attemptId: string, access: 'read' | 'write') => repo.claimConversation('c', binding.taskId, attemptId, {attemptId, access});

  it('preserves readers across reopen and releases only the matching token', async () => {
    expect(claim('one', 'read')).toBe(true);
    expect(claim('two', 'read')).toBe(true);
    expect(repo.claimPlanner('c', 'planner')).toBe(false);
    expect(claim('writer', 'write')).toBe(false);
    db.close();
    db = new Database(join(directory, 'state.sqlite'));
    initializeDatabaseSchema(db);
    repo = new WorkspaceGitRepo(db);
    repo.releaseConversation('c', 'one');
    expect(claim('writer', 'write')).toBe(false);
    expect(repo.conversationState(binding.worktreeId)).toMatchObject({state: 'executing', ownerToken: 'two'});
    repo.releaseConversation('c', 'one');
    expect(repo.conversationState(binding.worktreeId).ownerToken).toBe('two');
    repo.releaseConversation('c', 'two');
    expect(claim('writer', 'write')).toBe(true);
    expect(claim('three', 'read')).toBe(false);
  });

  it('reads the sealed writer version, preserves result witnesses, and rejects retry against changed input', async () => {
    expect(claim('reader', 'read')).toBe(true);
    await service.beginRead(binding, 'reader');
    await service.finishRead(binding, 'reader');
    repo.releaseConversation('c', 'reader');
    expect(claim('writer', 'write')).toBe(true);
    await writeFile(join(binding.executionRoot, 'input.txt'), 'after');
    const result = await service.sealAttempt(binding, 'writer');
    repo.releaseConversation('c', 'writer');
    expect(result.commit).not.toBe(binding.taskBaseCommit);
    expect(claim('next', 'read')).toBe(true);
    await service.beginRead(binding, 'next');
    expect(await service.finishRead(binding, 'next')).toBe(result.commit);
    expect(service.readResultCommit(binding, 'reader', 'correction')).toBe(binding.taskBaseCommit);
    await expect(service.sealAttempt(binding, 'correction')).rejects.toThrow('cannot_seal');
    await expect(service.beginRead(binding, 'retry', 'reader')).rejects.toThrow('input_changed');
    expect(repo.operationRecord('seal_reader')).toBeNull();
  });

  it.each([false, true])('recovers a stopped reader without sealing (dirty=%s)', async dirty => {
    claim('reader', 'read');
    await service.beginRead(binding, 'reader');
    if (dirty) await writeFile(join(binding.executionRoot, 'input.txt'), 'unexpected');
    // The backend removal witness is supplied by the recovery repository seam.
    vi.spyOn(repo, 'stoppedOwners').mockReturnValue([{conversationId: 'c', token: 'reader',
      attemptId: 'reader', taskId: binding.taskId, generationId: 'g', access: 'read'}]);
    const seal = vi.spyOn(service, 'sealAttempt');
    await new WorkspaceGitRecovery(service, new WorkspaceMergeWorker(git, repo)).recover(async () => undefined);
    expect(seal).not.toHaveBeenCalled();
    expect(repo.conversationState(binding.worktreeId)).toMatchObject({state: dirty ? 'failed' : 'idle', ownerToken: null});
    expect(repo.operationRecord('read_reader')?.state).toBe(dirty ? 'needs_recovery' : 'applied');
    expect(repo.conversation('c')!.headCommit).toBe(binding.taskBaseCommit);
  });
});
