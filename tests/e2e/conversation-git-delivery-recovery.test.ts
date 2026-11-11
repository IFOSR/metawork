import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/core/types.js';
import { UserArtifactPublicationService } from '../../src/delivery/user-artifact-publication-service.js';
import { ArtifactVersionRepo } from '../../src/storage/artifact-version-repo.js';
import { TaskArtifactRepo } from '../../src/storage/task-artifact-repo.js';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { scriptedRouterEvaluator } from '../support/router-decision-fixture.js';
import { FakeAttemptExecutionBackend, piCompletionOutput } from '../support/fake-attempt-execution-backend.js';
import { stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';

/**
 * Conversation Git delivery invariants (rebuilt 2026-11-07).
 *
 * These replace coverage that was lost when the in-place/publication suites were
 * removed: an authorized edit is sealed, merged once, and a recovery/restart pass
 * replays the merge without re-running the Executor or re-applying the change.
 */
function harness(goal: string, files: Record<string, string>, wait?: Promise<number>) {
  const root = process.env.ANYFUSION_INSTALL_ROOT!;
  const userRoot = process.env.ANYFUSION_TEST_WORKSPACE_SOURCE!;
  mkdirSync(userRoot, { recursive: true });
  const db = new Database(join(root, 'delivery-recovery.sqlite'));
  initializeDatabaseSchema(db);
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, join(root, 'tasks'));
  const attempts: number[] = [];
  const backend = new FakeAttemptExecutionBackend(input => {
    attempts.push(1);
    const workspace = input.mounts.find(mount => mount.target === '/workspace')!.source;
    for (const [name, content] of Object.entries(files)) writeFileSync(join(workspace, name), content);
    return { rawOutput: piCompletionOutput(input, '已修改工作区文件。'), artifacts: Object.keys(files), wait };
  });
  const plan = workGraphPlan({
    executor: 'pi-engineering',
    goal,
    deliveryKind: 'edit',
    fileOutputs: Object.keys(files),
    workspaceEffect: 'write',
  });
  const config: Config = {
    version: 1,
    executor: { command: 'pi', timeout: 60_000 },
    orchestration: {
      reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5,
      blocked_recheck_enabled: true, blocked_recheck_interval: 5, max_concurrent_attempts: 2,
    },
    ui: { language: 'zh-CN', dashboard_on_start: false },
  };
  const artifactVersionRepo = new ArtifactVersionRepo(db);
  const build = () => new MetaclawSession({
      spanRoutingEvaluator: scriptedRouterEvaluator(),
    taskEngine,
    orchestration: new OrchestrationEngine(taskEngine),
    attemptExecutionBackend: backend,
    db,
    config,
    sessionId: 'session_delivery_recovery',
    userArtifactPublication: new UserArtifactPublicationService({
      userWorkspaceRoot: userRoot,
      taskArtifactRepo: new TaskArtifactRepo(db),
      objectRoot: join(root, 'artifacts'),
      artifactVersionRepo,
    }),
    planningAgent: stubPlanningAgent(plan),
    getRuntimeBinding: async binding => ({
      revisionId: binding.configurationRevision,
      bindingFingerprint: authorizedExecutorBindingFingerprint(binding),
      environment: { OPENAI_BASE_URL: 'https://test.invalid/v1', OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'test-model' },
    }),
  });
  return { root, userRoot, db, taskRepo, backend, attempts, build, userFile: (name: string) => join(userRoot, name) };
}

describe('Conversation Git delivery recovery', () => {
  it('delivers an authorized edit once and replays the merge without re-running the Executor', async () => {
    const h = harness('把 notes.md 改成新内容', { 'notes.md': 'after' });
    try {
      const session = h.build();
      await session.initialize({ resumeStartupTasks: false, showDashboard: false });
      h.db.prepare('DELETE FROM work_units').run();
      await session.submit('把 notes.md 改成新内容', { awaitAsyncWork: true });

      const [task] = h.taskRepo.findAll();
      expect(task!.status).toBe('succeeded');
      expect(h.attempts).toHaveLength(1);
      expect(readFileSync(h.userFile('notes.md'), 'utf8')).toBe('after');
      expect(h.db.prepare("SELECT count(*) AS n FROM workspace_merge_jobs WHERE state='delivered'").get())
        .toEqual({ n: 1 });

      // A recovery pass on a fresh session must not execute or merge again.
      const restartedSession = h.build();
      await restartedSession.initialize({ resumeStartupTasks: true, showDashboard: false });
      await restartedSession.maybeReviewTaskPoolOnTimer();
      await restartedSession.maybeReviewTaskPoolOnTimer();

      expect(h.attempts).toHaveLength(1);
      expect(readFileSync(h.userFile('notes.md'), 'utf8')).toBe('after');
      expect(h.db.prepare('SELECT count(*) AS n FROM workspace_merge_jobs').get()).toEqual({ n: 1 });
      expect(h.taskRepo.findById(task!.id)?.status).toBe('succeeded');
      await restartedSession.dispose();
      await session.dispose();
    } finally {
      h.db.close();
    }
  }, 60_000);

  it('cancels before sealing and never publishes the private edits, including after restart', async () => {
    const h = harness('创建 notes.md', { 'notes.md': 'unpublished' }, new Promise(() => undefined));
    const session = h.build();
    let restarted: ReturnType<typeof h.build> | undefined;
    try {
      await session.initialize({ resumeStartupTasks: false, showDashboard: false });
      h.db.prepare('DELETE FROM work_units').run();
      const running = session.submit('创建 notes.md', { awaitAsyncWork: true });
      await vi.waitFor(() => expect(h.backend.wait).toHaveBeenCalled(), { timeout: 10_000 });
      const task = h.taskRepo.findAll()[0]!;
      await session.submit(`/task cancel ${task.id}`, { awaitAsyncWork: true });
      await running;
      expect(h.taskRepo.findById(task.id)?.status).toBe('cancelled');
      expect(h.attempts).toHaveLength(1);
      expect(existsSync(h.userFile('notes.md'))).toBe(false);
      expect(h.db.prepare("SELECT count(*) AS n FROM workspace_merge_jobs WHERE state = 'delivered'").get()).toEqual({ n: 0 });
      await session.dispose();
      restarted = h.build();
      await restarted.initialize({ resumeStartupTasks: true, showDashboard: false });
      await restarted.maybeReviewTaskPoolOnTimer();
      expect(h.taskRepo.findById(task.id)?.status).toBe('cancelled');
      expect(h.attempts).toHaveLength(1);
      expect(existsSync(h.userFile('notes.md'))).toBe(false);
    } finally {
      await restarted?.dispose();
      await session.dispose();
      h.db.close();
    }
  }, 60_000);
});
