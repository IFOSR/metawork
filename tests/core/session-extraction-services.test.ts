import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { runMigrations } from '../../src/storage/migrations.js';
import { SessionPersistenceService } from '../../src/session/session-persistence-service.js';
import { MemoryCaptureService } from '../../src/memory/memory-capture-service.js';
import { TaskResumePlanner } from '../../src/task/task-resume-planner.js';
import { taskControlPlan } from '../support/planning-agent-plans.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryAuditEventRepo } from '../../src/storage/memory-audit-event-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createRuntime(db: Database.Database) {
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, resolve(tmpdir(), `metaclaw-session-extraction-${Date.now()}`));
  const orchestration = new OrchestrationEngine(taskEngine);
  const executor: ExecutorAdapter = {
    name: 'codex-cli',
    execute: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    abort: vi.fn(),
  };
  const taskRuntimeService = new TaskRuntimeService({ taskEngine, taskRepo, orchestration });
  return { taskRepo, taskEngine, taskRuntimeService };
}

describe('session extraction services', () => {
  it('persists interactions outside MetaclawSession', () => {
    const db = createTestDb();
    const service = new SessionPersistenceService(db);

    service.recordInteraction({
      taskId: 'task_1',
      sessionId: 'session_1',
      userInput: 'build it',
      systemOutput: 'done',
      executorUsed: 'codex-cli',
    });

    const interaction = db.prepare('SELECT task_id, session_id, user_input, system_output, executor_used FROM interactions').get() as Record<string, string>;
    expect(interaction).toMatchObject({
      task_id: 'task_1',
      session_id: 'session_1',
      user_input: 'build it',
      system_output: 'done',
      executor_used: 'codex-cli',
    });
  });

  it('captures high-confidence preferences, audits auto-capture, and emits notification candidates', () => {
    const db = createTestDb();
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const notifier = { notifyTaskCompleted: vi.fn(), notifyMemoryCandidate: vi.fn().mockResolvedValue(undefined) };
    const service = new MemoryCaptureService({
      db,
      memoryEngine,
      notifier,
      deliveryService: {
        deliverMemoryCandidate: vi.fn((notificationService, input) => {
          void notificationService.notifyMemoryCandidate(input);
        }),
      },
    });

    const lowRisk = service.captureHighConfidencePreferences('偏好：以后报告默认先给结论再给证据', 'session:test');
    const highRisk = service.captureHighConfidencePreferences('偏好：以后凡是报告都自动发给客户', 'session:test');

    expect(lowRisk.lines.join('\n')).toContain('已自动记录偏好');
    expect(memoryEngine.list().map(pref => pref.content)).toContain('以后报告默认先给结论再给证据');
    expect(new MemoryAuditEventRepo(db).findByAction('auto_capture')).toHaveLength(1);
    expect(highRisk.lines.join('\n')).toContain('高风险偏好不会静默写入');
    expect(notifier.notifyMemoryCandidate).toHaveBeenCalledTimes(1);
  });

  it('resumes a planner-pinned parked task and forks a referenced done task without session branching', () => {
    const db = createTestDb();
    const { taskEngine, taskRuntimeService } = createRuntime(db);
    const planner = new TaskResumePlanner({ taskRuntimeService });

    const parked = taskEngine.create({ title: 'parked', goal: 'parked' });
    taskEngine.transition(parked.id, 'ready');
    taskEngine.transition(parked.id, 'running');
    taskEngine.park(parked.id, 'pause', {
      done: [],
      pending: ['continue'],
      nextStep: 'continue',
      pauseReason: 'pause',
    });
    // The planner already selected the parked task by taskId; runtime only
    // executes the deterministic resume (no keyword/session-pointer guessing).
    const resume = planner.planReferencedTask({
      userInput: `继续任务 ${parked.id}`,
      referencedTask: taskRuntimeService.findTask(parked.id)!,
      plan: taskControlPlan({ control: 'resume_task', taskId: parked.id, reason: 'resume parked' }),
    });
    expect(resume.action).toBe('execute_existing');
    expect(resume.action === 'execute_existing' ? resume.executionMode : null).toBe('resume-parked');

    const doneTask = taskEngine.create({ title: 'done', goal: 'done' });
    taskEngine.transition(doneTask.id, 'ready');
    taskEngine.transition(doneTask.id, 'running');
    const done = taskEngine.transition(doneTask.id, 'done');
    expect(planner.planReferencedTask({
      userInput: '基于它继续做',
      referencedTask: done,
      plan: taskControlPlan({ control: 'resume_task', taskId: done.id, reason: 'reference' }),
    }).action).toBe('fork_follow_up');
  });

  it.each([
    { control: 'recover_blocked' as const, reason: 'explicit blocked resume' },
    { control: 'resume_task' as const, reason: 'resume the blocked task' },
  ])('unblocks a planner-pinned blocked task on $control with material extraction', ({ control, reason }) => {
    const db = createTestDb();
    const { taskEngine, taskRuntimeService } = createRuntime(db);
    const planner = new TaskResumePlanner({ taskRuntimeService });

    const blocked = taskEngine.create({ title: 'blocked', goal: 'blocked' });
    taskEngine.transition(blocked.id, 'ready');
    taskEngine.transition(blocked.id, 'running');
    taskEngine.block(blocked.id, {
      taskId: blocked.id,
      type: 'manual',
      description: '等待材料',
      status: 'waiting',
    });
    const blockedSnapshot = taskRuntimeService.findTask(blocked.id);
    expect(blockedSnapshot?.status).toBe('blocked');

    const recovery = planner.planReferencedTask({
      userInput: `材料已补充，可以继续 ${blocked.id}`,
      referencedTask: blockedSnapshot!,
      plan: taskControlPlan({ control, taskId: blocked.id, reason }),
    });
    expect(recovery.action).toBe('unblock_and_execute');
    expect(recovery.action === 'unblock_and_execute'
      ? recovery.triggerReason
      : null).toBe(reason);
  });

  it('reports a running planner-pinned task as already executing instead of re-queueing it', () => {
    const db = createTestDb();
    const { taskEngine, taskRuntimeService } = createRuntime(db);
    const planner = new TaskResumePlanner({ taskRuntimeService });

    const task = taskEngine.create({ title: 'running', goal: 'running' });
    taskEngine.transition(task.id, 'ready');
    const running = taskEngine.transition(task.id, 'running');

    const result = planner.planReferencedTask({
      userInput: `恢复任务 ${task.id}`,
      referencedTask: running,
      plan: taskControlPlan({ control: 'resume_task', taskId: task.id, reason: 'resume running' }),
    });

    expect(result.action).toBe('message');
    expect(result.action === 'message' ? result.lines.join('\n') : '').toContain('已在执行中');
  });

  it('surfaces an error for a blocked task with no waiting dependency instead of force-unblocking it', () => {
    const db = createTestDb();
    const { taskEngine, taskRuntimeService } = createRuntime(db);
    const planner = new TaskResumePlanner({ taskRuntimeService });

    const task = taskEngine.create({ title: 'blocked-no-dep', goal: 'blocked-no-dep' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    // Blocked but with no *waiting* dependency to clear (already-resolved dep):
    // a resume has nothing to unblock, so it must not silently push the task on.
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: 'resolved out-of-band',
      status: 'resolved',
    });
    const blocked = taskRuntimeService.findTask(task.id)!;
    expect(blocked.status).toBe('blocked');

    const result = planner.planReferencedTask({
      userInput: `网络好了，继续 ${task.id}`,
      referencedTask: blocked,
      plan: taskControlPlan({ control: 'recover_blocked', taskId: task.id, reason: 'resume blocked' }),
    });

    expect(result.action).toBe('message');
    expect(result.action === 'message' ? result.lines.join('\n') : '').toContain('错误');
  });
});
