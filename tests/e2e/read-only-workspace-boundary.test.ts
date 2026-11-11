import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/types.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskArtifactRepo } from '../../src/storage/task-artifact-repo.js';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { ArtifactVersionRepo } from '../../src/storage/artifact-version-repo.js';
import { UserArtifactPublicationService } from '../../src/delivery/user-artifact-publication-service.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { scriptedRouterEvaluator } from '../support/router-decision-fixture.js';
import { resolveWorkspaceWriteEffect, writesWorkspace } from '../../src/work-graph/workspace-effect.js';
import { FakeAttemptExecutionBackend, piCompletionOutput } from '../support/fake-attempt-execution-backend.js';
import { stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';

// Convergence review B-01: a read-only Workspace authorization can never be
// executed as a write, and its Attempt can never merge business files into the
// user's Workspace. Only the Planner model and the Executor side effect are
// deterministic fixtures.
const config: Config = {
  version: 1, executor: { command: 'pi', timeout: 60_000 },
  orchestration: { reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5,
    blocked_recheck_enabled: true, blocked_recheck_interval: 5, max_concurrent_attempts: 4 },
  ui: { language: 'zh-CN', dashboard_on_start: false },
};

function fixture(responder: (mounts: Array<{ target: string; source: string; mode: string }>, scratch: string) => void) {
  const root = process.env.ANYFUSION_INSTALL_ROOT!;
  mkdirSync(join(root, 'app/current/dist'), { recursive: true });
  writeFileSync(join(root, 'app/current/dist/pi-attempt-tools.ts'), 'export default function () {}\n');
  const userRoot = process.env.ANYFUSION_TEST_WORKSPACE_SOURCE!;
  mkdirSync(userRoot, { recursive: true });
  writeFileSync(join(userRoot, 'README.md'), '# workspace\n');
  const db = new Database(join(root, 'read-only.sqlite'));
  initializeDatabaseSchema(db);
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, join(root, 'tasks'));
  const backend = new FakeAttemptExecutionBackend(input => {
    const mounts = input.mounts.map(mount => ({ target: mount.target, source: mount.source, mode: String(mount.mode) }));
    responder(mounts, mounts.find(mount => mount.target === '/workspace')!.source);
    return { rawOutput: piCompletionOutput(input, '分析完成，未请求文件交付。') };
  });
  // A report with no declared output and an explicitly read-only intent: the
  // Planner is allowed to omit `workspaceEffect` here (schema 9 does).
  const plan = workGraphPlan({ goal: '分析项目并返回结论，不修改工作区', deliveryKind: 'report', fileOutputs: [], executor: 'pi-engineering' });
  const session = new MetaclawSession({
      spanRoutingEvaluator: scriptedRouterEvaluator(),
    taskEngine, db, config, sessionId: 'read-only-boundary',
    orchestration: new OrchestrationEngine(taskEngine),
    userArtifactPublication: new UserArtifactPublicationService({ userWorkspaceRoot: userRoot,
      taskArtifactRepo: new TaskArtifactRepo(db), artifactVersionRepo: new ArtifactVersionRepo(db),
      objectRoot: join(root, 'artifacts') }),
    attemptExecutionBackend: backend,
    planningAgent: stubPlanningAgent(plan),
    getRuntimeBinding: async binding => ({ revisionId: binding.configurationRevision,
      bindingFingerprint: authorizedExecutorBindingFingerprint(binding),
      environment: { OPENAI_BASE_URL: 'https://test.invalid/v1', OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'test-model' } }),
  });
  return { db, taskRepo, session, userRoot, backend };
}

describe('read-only Workspace authorization boundary', () => {
  it('resolves an omitted effect on a read-shaped node as read access', () => {
    const node = { id: 'research', deliveryKind: 'report' as const, fileOutputs: [] };
    expect(resolveWorkspaceWriteEffect(node, [])).toBe('read_only');
    expect(writesWorkspace(node, [])).toBe(false);
  });

  it('runs the Attempt outside the Conversation Worktree and delivers nothing', async () => {
    const f = fixture(mounts => {
      // The reader's `/workspace` is an attempt-owned scratch; the business tree
      // is mounted read-only as `/source`.
      expect(mounts.find(mount => mount.target === '/workspace')!.source).toContain('/read-only/');
      expect(mounts.find(mount => mount.target === '/source')!.mode).toBe('ro');
    });
    try {
      f.session.initialize({ resumeStartupTasks: false, showDashboard: false });
      f.db.prepare('DELETE FROM work_units').run();
      await f.session.submit('分析项目并返回结论，不修改工作区', { awaitAsyncWork: true });
      await f.session.maybeReviewTaskPoolOnTimer();
      const [task] = f.taskRepo.findAll();
      expect(task!.status).toBe('succeeded');
      expect(new SubtaskRepo(f.db).listByTask(task!.id)[0]!.status).toBe('done');
      expect(f.db.prepare('SELECT count(*) AS n FROM workspace_merge_jobs').get()).toEqual({ n: 0 });
      expect(readdirSync(f.userRoot).sort()).toEqual(['README.md']);
    } finally {
      await f.session.dispose();
      f.db.close();
    }
  }, 60_000);

  it('isolates a reader that writes the business tree instead of merging its files', async () => {
    const f = fixture(mounts => {
      const business = mounts.find(mount => mount.target === '/source')!.source;
      const scratch = mounts.find(mount => mount.target === '/workspace')!.source;
      writeFileSync(join(scratch, 'report-scratch.md'), '# scratch\n');
      writeFileSync(join(business, 'browser_launch_report.md'), '# unsolicited\n');
      writeFileSync(join(business, 'browser_launch_result.txt'), 'unsolicited\n');
    });
    try {
      f.session.initialize({ resumeStartupTasks: false, showDashboard: false });
      f.db.prepare('DELETE FROM work_units').run();
      await f.session.submit('分析项目并返回结论，不修改工作区', { awaitAsyncWork: true });
      await f.session.maybeReviewTaskPoolOnTimer();
      const [task] = f.taskRepo.findAll();
      // Isolation is the only safe outcome: no merge, no artifact, no new output.
      expect(task!.status).not.toBe('succeeded');
      expect(f.db.prepare('SELECT count(*) AS n FROM workspace_merge_jobs').get()).toEqual({ n: 0 });
      expect(f.db.prepare('SELECT count(*) AS n FROM task_artifacts').get()).toEqual({ n: 0 });
      expect(f.db.prepare('SELECT state FROM conversation_git_worktrees').get()).toEqual({ state: 'failed' });
      expect(f.db.prepare("SELECT state FROM workspace_git_operations WHERE kind='read_observation'").get())
        .toEqual({ state: 'needs_recovery' });
      const subtask = new SubtaskRepo(f.db).listByTask(task!.id)[0]!;
      expect(subtask.status).not.toBe('done');
      expect(existsSync(join(f.userRoot, 'browser_launch_report.md'))).toBe(false);
      expect(existsSync(join(f.userRoot, 'browser_launch_result.txt'))).toBe(false);
      expect(readdirSync(f.userRoot).sort()).toEqual(['README.md']);
    } finally {
      await f.session.dispose();
      f.db.close();
    }
  }, 60_000);
});
