import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';
import { completionResponse } from '../support/completion-response.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 60_000,
    },
    orchestration: {
      max_concurrent_attempts: 4,
      reminder_enabled: true,
      reminder_throttle: 3600,
      top_k_preferences: 5,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

describe('Round 7 inline materials acceptance', () => {
  it('creates a task with inline file paths and auto-attaches those materials', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const fixturesDir = resolve(tmpdir(), 'metaclaw-inline-materials-round7');
    mkdirSync(fixturesDir, { recursive: true });
    const weeklyPath = resolve(fixturesDir, 'phoenix-weekly.md');
    const riskPath = resolve(fixturesDir, 'risks.md');
    writeFileSync(weeklyPath, '本周完成 Phoenix 核心模块联调。', 'utf-8');
    writeFileSync(riskPath, '当前风险在跨团队依赖和测试数据准备不足。', 'utf-8');

    const plan = workGraphPlan({ goal: 'Use the two Task resources to prepare the Phoenix weekly summary.' });
    plan.workGraph!.subtasks[0]!.contextRefs = [{ kind: 'task_resource', locator: weeklyPath }, { kind: 'task_resource', locator: riskPath }];

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async (input) => ({
        success: true,
        output: completionResponse(input, input.context.selectedEvidence.map(item => item.content).join(' | ')),
        exitCode: 0,
        durationMs: 80,
      })),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_round7_inline_materials',
      contextRecaller,
      planningAgent: stubPlanningAgent(plan),
    });

    session.initialize();
    await session.submit(`基于 ${weeklyPath} 和 ${riskPath} 整理 Phoenix 周报，输出一个简短结论`, { awaitAsyncWork: true });

    const doneTask = taskRepo.findByStatus('done')[0];
    expect(doneTask).toBeDefined();
    expect(doneTask.resources).toEqual([weeklyPath, riskPath]);
    expect(doneTask.title).not.toContain(weeklyPath);

    const output = session.getSnapshot().output.join('\n');
    expect(output).not.toContain('已自动关联 2 份材料');
    expect(output).toContain('【Executor: codex-cli｜派发准备】');
    expect(output).toContain('核心模块联调');
    expect(output).toContain('测试数据准备不足');
  });
});
