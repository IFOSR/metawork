import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { UserArtifactPublicationService, userTaskDirectorySlug } from '../../src/delivery/user-artifact-publication-service.js';
import { TaskArtifactRepo } from '../../src/storage/task-artifact-repo.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';
import { SqliteTaskActivityFacts } from '../../src/storage/task-activity-facts-repo.js';
import { projectTaskView } from '../../src/task/task-view.js';
import Database from 'better-sqlite3';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { Config } from '../../src/core/types.js';
import { stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';
import { FakeAttemptExecutionBackend } from '../support/fake-attempt-execution-backend.js';
import { KernelExecutorStatusProjector } from '../../src/execution/kernel-executor-status-projector.js';
import { KernelExecutorStatusRepo } from '../../src/storage/kernel-executor-status-repo.js';

describe('Durable delivery end-to-end control loop', () => {
  it.each(['resume', 'restart', 'copy_before_save', 'cancel'] as const)('preserves integrated output after real copy failure and %s without executing again', async mode => {
    const userRoot = join(process.env.ANYFUSION_INSTALL_ROOT!, 'user-output');
    if (mode === 'copy_before_save') mkdirSync(userRoot);
    else writeFileSync(userRoot, 'a file blocks creation of the user output directory');
    const db = new Database(':memory:');
    runMigrations(db);
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-kernel-capacity');
    const artifacts = new TaskArtifactRepo(db);
    const delivery = new UserArtifactPublicationService({ userWorkspaceRoot: userRoot, taskArtifactRepo: artifacts });
    const copy = vi.spyOn(delivery, 'publishIntegratedArtifacts');
    const attemptExecutionBackend = new FakeAttemptExecutionBackend(input => {
      const workspace = input.mounts.find(mount => mount.target === '/workspace')!.source;
      writeFileSync(join(workspace, 'answer.md'), '# Persisted answer');
      return { body: 'file produced' };
    });
    const plan = workGraphPlan({ goal: 'deliver one file', deliveryKind: 'report', fileOutputs: ['answer.md'] });
    const config: Config = {
      version: 1,
      executor: { command: 'codex', timeout: 60_000 },
      orchestration: {
        reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5,
        blocked_recheck_enabled: true, blocked_recheck_interval: 5,
        max_concurrent_attempts: 4,
      },
      ui: { language: 'zh-CN', dashboard_on_start: false },
    };
    const buildSession = () => new MetaclawSession({
      taskEngine,
      userArtifactPublication: delivery,
      memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
      orchestration: new OrchestrationEngine(taskEngine),
      attemptExecutionBackend,
      db,
      config,
      sessionId: 'session_capacity',
      contextRecaller: new ContextRecaller(db),
      planningAgent: stubPlanningAgent(plan),
      getRuntimeBinding: async binding => ({
        revisionId: binding.configurationRevision,
        bindingFingerprint: 'test-fingerprint',
        environment: {
          OPENAI_BASE_URL: 'https://test.invalid/v1',
          OPENAI_API_KEY: 'sk-test',
          OPENAI_MODEL: 'test-model',
        },
      }),
    });
    let session = buildSession();
    const landing = mode === 'copy_before_save' ? vi.spyOn(WorkspacePublicationRepo.prototype, 'settleDelivery')
      .mockImplementationOnce(() => { throw new Error('injected process interruption after filesystem copy'); }) : null;
    session.initialize({ resumeStartupTasks: false, showDashboard: false });
    db.prepare('DELETE FROM work_units').run();

    await session.submit('run after capacity recovers', { awaitAsyncWork: true });

    const [task] = taskRepo.findAll();
    const publications = new WorkspacePublicationRepo(db);
    const [publication] = publications.listByTask(task.id);
    const view = () => projectTaskView(new SqliteTaskActivityFacts(db).read(taskRepo.findById(task.id)!, null));
    expect(publication.status).toBe('integrated');
    landing?.mockRestore();
    expect(publications.delivery(publication.id)).toMatchObject(mode === 'copy_before_save'
      ? { status: 'pending' } : { status: 'failed', failures: [expect.any(Object)] });
    expect(db.prepare('SELECT status FROM subtasks WHERE task_id = ?').get(task.id)).toEqual({ status: 'awaiting_integration' });
    if (mode !== 'copy_before_save') {
      expect(view()).toMatchObject({
        status: 'failed',
        state: { reason: { code: 'delivery_failed', message: expect.stringContaining('文件交付失败') } },
      });
      expect(view().pendingActions.some(action => action.kind === 'resolve_recovery')).toBe(false);
    }
    expect(db.prepare('SELECT count(*) AS n FROM subtask_handoffs').get()).toEqual({ n: 0 });
    if (mode !== 'copy_before_save') await session.maybeReviewTaskPoolOnTimer();
    expect(copy).toHaveBeenCalledTimes(1);
    expect(attemptExecutionBackend.create).toHaveBeenCalledTimes(1);
    if (mode !== 'copy_before_save') { rmSync(userRoot); mkdirSync(userRoot); }
    if (mode === 'restart' || mode === 'copy_before_save') {
      session = buildSession();
      session.initialize({ resumeStartupTasks: false, showDashboard: false });
    }
    if (mode === 'cancel') {
      await session.submit(`/task cancel ${task.id}`, { awaitAsyncWork: true });
    }
    await session.submit(`/task resume ${task.id} --generation obsolete --revision 99`, { awaitAsyncWork: true });
    if (mode !== 'copy_before_save') expect(copy).toHaveBeenCalledTimes(1);
    const command = mode === 'copy_before_save' ? 'resume' : mode === 'cancel' ? 'cancel' : 'retry';
    await session.submit(`/task ${command} ${task.id}`, { awaitAsyncWork: true });
    await session.submit(`/task ${command} ${task.id}`, { awaitAsyncWork: true });
    expect(attemptExecutionBackend.create).toHaveBeenCalledTimes(1);
    if (mode !== 'cancel') {
      expect(publications.delivery(publication.id)?.status, JSON.stringify({output:session.getSnapshot().output, effects:db.prepare("SELECT status, error_summary FROM kernel_effect_outbox WHERE effect_type='task_remaining_work'").all()})).toBe('succeeded');
      expect(taskRepo.findById(task.id)?.status).toBe(mode === 'copy_before_save' ? 'succeeded' : 'failed');
      if (mode !== 'copy_before_save') {
        const retries = taskRepo.findAll().filter(item => item.retryOfTaskId === task.id);
        expect(retries, JSON.stringify(session.getSnapshot().output)).toHaveLength(1);
        expect(retries[0]!.status, JSON.stringify(retries[0]!.stateDetail)).toBe('succeeded');
      }
      expect(copy).toHaveBeenCalledTimes(2);
      expect(readFileSync(join(userRoot, 'metaclaw-tasks', userTaskDirectorySlug(task.title, task.id), 'answer.md'), 'utf8')).toBe('# Persisted answer');
      expect(db.prepare('SELECT count(*) AS n FROM task_artifacts').get()).toEqual({ n: 1 });
      expect(publications.countMergeAttempts(publication.id)).toBe(1);
    } else {
      expect(taskRepo.findById(task.id)?.status).toBe('failed');
      expect(copy).toHaveBeenCalledTimes(1);
      expect(db.prepare('SELECT count(*) AS n FROM subtask_handoffs').get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM subtasks WHERE task_id = ? AND status = 'succeeded'").get(task.id)).toEqual({ n: 0 });
    }
    // The original failure is immutable; successful retries have their own Task.
    expect(view().status).toBe(mode === 'copy_before_save' ? 'succeeded' : 'failed');
    db.close();
  });
});
