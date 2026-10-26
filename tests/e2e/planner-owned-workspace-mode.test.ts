import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/types.js';
import { UserArtifactPublicationService } from '../../src/delivery/user-artifact-publication-service.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskArtifactRepo } from '../../src/storage/task-artifact-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { WorkspaceExecutionBindingRepo } from '../../src/storage/workspace-execution-binding-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { WorkspaceIntent } from '../../src/core/workspace-execution.js';
import { FakeAttemptExecutionBackend } from '../support/fake-attempt-execution-backend.js';
import { stubPlanningAgent, workspaceIntentFixture, workGraphPlan } from '../support/planning-agent-plans.js';

// Real Session -> Planner proposal (schema 9) -> Kernel admission -> Runtime ->
// attempt -> publication. Only the Planner model and the Executor side effect
// are deterministic fixtures.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  db: Database.Database;
  repo: TaskRepo;
  engine: TaskEngine;
  session: MetaclawSession;
  userRoot: string;
  backend: FakeAttemptExecutionBackend;
  mounts: string[];
}

function harness(options: {
  intent: Partial<WorkspaceIntent>;
  goal: string;
  fileOutputs: string[];
  responder: (input: Parameters<FakeAttemptExecutionBackend['create']>[0], workspace: string) => {
    body?: string;
    artifacts?: string[];
  };
  deliveryKind?: 'edit' | 'report';
  publicProjectDirectory?: string;
}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'metawork-planner-workspace-mode-'));
  roots.push(root);
  const installRoot = process.env.ANYFUSION_INSTALL_ROOT!;
  mkdirSync(join(installRoot, 'app/current/dist'), { recursive: true });
  writeFileSync(join(installRoot, 'app/current/dist/pi-attempt-tools.ts'), 'export default function () {}\n');
  const userRoot = join(root, 'workspace');
  mkdirSync(userRoot, { recursive: true });
  writeFileSync(join(userRoot, 'app.txt'), 'before');
  if (options.publicProjectDirectory) {
    mkdirSync(join(userRoot, options.publicProjectDirectory), { recursive: true });
    writeFileSync(join(userRoot, options.publicProjectDirectory, 'app.txt'), 'before-project');
  }
  const db = new Database(join(root, 'mode.sqlite'));
  runMigrations(db);
  const repo = new TaskRepo(db);
  const engine = new TaskEngine(repo, join(root, 'tasks'));
  const mounts: string[] = [];
  const backend = new FakeAttemptExecutionBackend(input => {
    const workspace = input.mounts.find(mount => mount.target === '/workspace')!.source;
    mounts.push(workspace);
    return options.responder(input, workspace);
  });
  const basePlan = workGraphPlan({
    goal: options.goal,
    deliveryKind: options.deliveryKind ?? 'edit',
    fileOutputs: options.fileOutputs,
  });
  const plan = {
    ...basePlan,
    schemaVersion: 9 as const,
    workGraph: basePlan.workGraph
      ? { ...basePlan.workGraph, configurationRevision: 'revision-test' }
      : null,
    workspaceIntent: workspaceIntentFixture(options.intent),
    ...(options.publicProjectDirectory
      ? { task: { ...basePlan.task, publicProjectDirectory: options.publicProjectDirectory } }
      : {}),
  };
  const config: Config = {
    version: 1, executor: { command: 'codex', timeout: 60_000 },
    orchestration: { reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5,
      blocked_recheck_enabled: true, blocked_recheck_interval: 5, max_concurrent_attempts: 4 },
    ui: { language: 'zh-CN', dashboard_on_start: false },
  };
  const session = new MetaclawSession({
    taskEngine: engine,
    db,
    config,
    sessionId: 'planner-workspace-mode',
    sourceRoot: userRoot,
    memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
    orchestration: new OrchestrationEngine(engine),
    contextRecaller: new ContextRecaller(db),
    userArtifactPublication: new UserArtifactPublicationService({
      userWorkspaceRoot: userRoot,
      taskArtifactRepo: new TaskArtifactRepo(db),
    }),
    attemptExecutionBackend: backend,
    planningAgent: stubPlanningAgent(plan),
    getRuntimeBinding: async binding => ({
      revisionId: binding.configurationRevision,
      bindingFingerprint: 'test-fingerprint',
      environment: {
        OPENAI_BASE_URL: 'https://test.invalid/v1',
        OPENAI_API_KEY: 'sk-test',
        ANTHROPIC_API_KEY: 'sk-test',
        OPENAI_MODEL: 'test-model',
      },
    }),
  });
  return { db, repo, engine, session, userRoot, backend, mounts };
}

async function run(h: Harness, goal: string): Promise<void> {
  h.session.initialize({ resumeStartupTasks: false, showDashboard: false });
  h.db.prepare('DELETE FROM work_units').run();
  await h.session.submit(goal, { awaitAsyncWork: true });
  await h.session.maybeReviewTaskPoolOnTimer();
}

describe('Planner-owned Workspace execution mode end-to-end', () => {
  it('keeps a read-only report and its scratch artifacts out of the user Workspace', async () => {
    const h = harness({
      goal: '分析项目并返回结论，不修改工作区',
      deliveryKind: 'report',
      fileOutputs: [],
      intent: {
        operation: 'read_only',
        targetPaths: [],
        originalFilePolicy: 'may_replace',
        isolationPolicy: 'not_requested',
        proposedMode: null,
        reason: '用户只需要分析结论，不授权工作区写入',
      },
      responder: (_input, workspace) => {
        writeFileSync(join(workspace, 'report-scratch.md'), '# internal report\n');
        return { body: '分析完成。', artifacts: ['report-scratch.md'] };
      },
    });
    try {
      await run(h, '分析项目并返回结论，不修改工作区');
      const task = h.repo.findAll()[0]!;
      expect(task.executionMode).toBe('in_place');
      expect(task.workspaceDeliveryPolicy).toBe('none');
      expect(task.status).toBe('succeeded');
      expect(h.mounts[0]).not.toBe(realpathSync(h.userRoot));
      expect(existsSync(join(h.userRoot, 'report-scratch.md'))).toBe(false);
    } finally {
      h.db.close();
    }
  }, 60_000);

  it('runs an ordinary Workspace edit in place and delivers live references', async () => {
    const h = harness({
      goal: '把工作区里的 app.txt 改成 after',
      fileOutputs: ['app.txt'],
      intent: {
        operation: 'modify_existing',
        targetPaths: ['app.txt'],
        originalFilePolicy: 'may_replace',
        isolationPolicy: 'not_requested',
        proposedMode: 'in_place',
        reason: '用户要求直接修改目标项目的文件',
      },
      responder: (_input, workspace) => {
        writeFileSync(join(workspace, 'app.txt'), 'after');
        return { body: '已修改 app.txt。', artifacts: ['app.txt'] };
      },
    });
    try {
      await run(h, '把工作区里的 app.txt 改成 after');
      const task = h.repo.findAll()[0]!;
      expect(task.executionMode).toBe('in_place');
      expect(task.workspaceExecutionSource).toBe('planner');
      expect(task.workspaceDeliveryPolicy).toBe('none');
      expect(task.workspaceTargetPaths).toEqual(['app.txt']);
      expect(task.status).toBe('succeeded');
      // The Executor ran directly in the target Workspace.
      expect(h.mounts).toEqual([realpathSync(h.userRoot)]);
      expect(readFileSync(join(h.userRoot, 'app.txt'), 'utf8')).toBe('after');
      expect(readdirSync(h.userRoot).filter(name => name.startsWith('metaclaw-tasks'))).toEqual([]);
      const artifacts = new TaskArtifactRepo(h.db).listByTask(task.id);
      expect(artifacts.map(artifact => artifact.relativePath)).toEqual(['app.txt']);
      expect(artifacts[0]!.referenceKind).toBe('live_file');
      expect(artifacts[0]!.publishedPath).toBe(join(realpathSync(h.userRoot), 'app.txt'));
      const bindings = new WorkspaceExecutionBindingRepo(h.db).listByTask(task.id);
      // The Kernel pinned the Planner judgement on the durable generation binding.
      expect(bindings[0]?.executionMode).toBe('in_place');
      expect(bindings[0]?.modeSource).toBe('planner');
      expect(bindings[0]?.deliveryPolicy).toBe('none');
      const subtask = new SubtaskRepo(h.db).listByTask(task.id)[0]!;
      expect(subtask.status).toBe('done');
      expect(subtask.fileOutputs).toEqual(['app.txt']);
    } finally {
      h.db.close();
    }
  }, 60_000);

  it('writes an ordinary edit directly into the target Workspace', async () => {
    const h = harness({
      goal: '直接修改 app.txt',
      fileOutputs: ['app.txt'],
      intent: {
        operation: 'modify_existing',
        targetPaths: ['app.txt'],
        originalFilePolicy: 'may_replace',
        reason: '用户要求直接修改目标工作区',
      },
      responder: (_input, workspace) => {
        writeFileSync(join(workspace, 'app.txt'), 'candidate');
        return { body: '已直接修改。', artifacts: ['app.txt'] };
      },
    });
    try {
      await run(h, '直接修改 app.txt');
      const task = h.repo.findAll()[0]!;
      expect(task.executionMode).toBe('in_place');
      expect(task.workspaceDeliveryPolicy).toBe('none');
      expect(task.status).toBe('succeeded');
      expect(h.mounts).toEqual([realpathSync(h.userRoot)]);
      expect(readFileSync(join(h.userRoot, 'app.txt'), 'utf8')).toBe('candidate');
      expect(h.db.prepare('SELECT COUNT(*) AS count FROM workspace_publications WHERE task_id = ?').get(task.id)).toMatchObject({ count: 0 });
    } finally {
      h.db.close();
    }
  }, 60_000);

  it('applies multiple declared changes directly without a publication phase', async () => {
    const h = harness({
      goal: '直接修改 notes.md 和 app.txt',
      fileOutputs: ['notes.md'],
      intent: {
        operation: 'modify_existing',
        targetPaths: ['notes.md', 'app.txt'],
        originalFilePolicy: 'may_replace',
        reason: '用户要求直接修改目标工作区中的文件',
      },
      responder: (_input, workspace) => {
        writeFileSync(join(workspace, 'notes.md'), '# notes');
        writeFileSync(join(workspace, 'app.txt'), 'after-isolation');
        return { body: '已完成隔离修改。', artifacts: ['notes.md'] };
      },
    });
    try {
      await run(h, '直接修改 notes.md 和 app.txt');
      const task = h.repo.findAll()[0]!;
      expect(task.executionMode).toBe('in_place');
      expect(task.workspaceDeliveryPolicy).toBe('none');
      expect(task.status).toBe('succeeded');
      // The authorized changes are already in the target Workspace.
      expect(readFileSync(join(h.userRoot, 'notes.md'), 'utf8')).toBe('# notes');
      expect(readFileSync(join(h.userRoot, 'app.txt'), 'utf8')).toBe('after-isolation');
      expect(readdirSync(h.userRoot).filter(name => name.startsWith('metaclaw-tasks'))).toEqual([]);
      const artifacts = new TaskArtifactRepo(h.db).listByTask(task.id);
      expect(artifacts.map(item => item.relativePath)).toContain('notes.md');
      expect(artifacts.every(item => item.publishedPath.startsWith(realpathSync(h.userRoot)))).toBe(true);
      expect(h.mounts).toEqual([realpathSync(h.userRoot)]);
      expect(h.db.prepare('SELECT COUNT(*) AS count FROM workspace_publications WHERE task_id = ?').get(task.id)).toMatchObject({ count: 0 });
      const bindings = new WorkspaceExecutionBindingRepo(h.db).listByTask(task.id);
      expect(bindings[0]?.modeSource).toBe('planner');
      expect(bindings[0]?.deliveryPolicy).toBe('none');
      expect(bindings[0]?.authorizedWorkingDirectory).toBe(realpathSync(h.userRoot));
    } finally {
      h.db.close();
    }
  }, 60_000);

  it('publishes an explicitly selected project at that project root', async () => {
    const h = harness({
      goal: '更新 existing 项目中的 app.txt',
      fileOutputs: ['existing/app.txt'],
      publicProjectDirectory: 'existing',
      intent: {
        operation: 'modify_existing',
        targetPaths: ['existing/app.txt'],
        originalFilePolicy: 'may_replace',
        isolationPolicy: 'not_requested',
        proposedMode: 'worktree',
        reason: '用户明确选择 existing 项目并要求隔离后发布',
      },
      responder: (_input, workspace) => {
        writeFileSync(join(workspace, 'existing', 'app.txt'), 'project-update');
        return { body: '已更新项目文件。', artifacts: ['existing/app.txt'] };
      },
    });
    try {
      await run(h, '更新 existing 项目中的 app.txt');
      const task = h.repo.findAll()[0]!;
      expect(task.publicProject).toBe(true);
      expect(task.status).toBe('succeeded');
      expect(readFileSync(join(h.userRoot, 'existing', 'app.txt'), 'utf8')).toBe('project-update');
      expect(existsSync(join(h.userRoot, 'existing', 'existing', 'app.txt'))).toBe(false);
    } finally {
      h.db.close();
    }
  }, 60_000);

  it('keeps the fixed mode across a retry of the same Task', async () => {
    let attempts = 0;
    const h = harness({
      goal: '修改 app.txt，第一次失败后重试',
      fileOutputs: ['app.txt'],
      intent: {
        operation: 'modify_existing',
        targetPaths: ['app.txt'],
        proposedMode: 'in_place',
        reason: '普通工作区编辑',
      },
      responder: (_input, workspace) => {
        attempts += 1;
        if (attempts === 1) return { body: '第一次尝试。', artifacts: [] };
        writeFileSync(join(workspace, 'app.txt'), 'retried');
        return { body: '已重试完成。', artifacts: ['app.txt'] };
      },
    });
    try {
      await run(h, '修改 app.txt，第一次失败后重试');
      const task = h.repo.findAll()[0]!;
      expect(task.executionMode).toBe('in_place');
      expect(task.workspaceExecutionSource).toBe('planner');
      // A missing declared output keeps the round uncertified; the Task keeps
      // its fixed mode and never silently switches to a copy tree.
      expect(task.status).not.toBe('succeeded');
      expect(readFileSync(join(h.userRoot, 'app.txt'), 'utf8')).toBe('before');
      expect(new SubtaskRepo(h.db).listByTask(task.id)[0]!.status).not.toBe('done');
    } finally {
      h.db.close();
    }
  }, 60_000);
});
