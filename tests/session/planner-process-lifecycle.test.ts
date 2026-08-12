import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { PlannerProcessController } from '../../src/planning/planner-process-supervisor.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { stubPlanningAgent } from '../support/planning-agent-plans.js';

function createSession(plannerSupervisor: PlannerProcessController) {
  const db = new Database(':memory:');
  runMigrations(db);
  const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/metaclaw-planner-lifecycle');
  return new MetaclawSession({
    taskEngine,
    memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
    orchestration: new OrchestrationEngine(taskEngine),
    db,
    config: {
      version: 1,
      executor: { command: 'codex', timeout: 60_000 },
      orchestration: {
        max_concurrent_attempts: 1,
        reminder_enabled: false,
        reminder_throttle: 3_600,
        top_k_preferences: 5,
      },
      ui: { language: 'zh-CN', dashboard_on_start: false },
    },
    sessionId: 'session-lifecycle',
    contextRecaller: new ContextRecaller(db),
    planningAgent: stubPlanningAgent(),
    plannerSupervisor,
  });
}

describe('MetaclawSession Planner process lifecycle', () => {
  it('stops only its shared Planner session and makes disposal idempotent', async () => {
    const plannerSupervisor: PlannerProcessController = {
      run: vi.fn(),
      stop: vi.fn(),
      stopSession: vi.fn(async () => undefined),
    };
    const session = createSession(plannerSupervisor);

    await Promise.all([session.dispose(), session.dispose()]);

    expect(plannerSupervisor.stopSession).toHaveBeenCalledTimes(1);
    expect(plannerSupervisor.stopSession).toHaveBeenCalledWith('session-lifecycle');
    expect(plannerSupervisor.stop).not.toHaveBeenCalled();
  });
});
