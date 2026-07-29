import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
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

describe('Round 1 memory acceptance', () => {
  it('不再从自然语言重复模式写入长期偏好，显式 /memory add 仍可写入', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: '邮件草稿已生成',
        exitCode: 0,
        durationMs: 120,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
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
      sessionId: 'sess_memory_round1_confirm',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '给张总写一封邮件，内容是汇报本周进展，用正式语气' }),
        workGraphPlan({ goal: '再给张总写一封邮件，内容是同步项目风险，用正式语气' }),
        workGraphPlan({ goal: '继续给张总准备一封邮件，内容是安排下周会议，用正式语气' }),
        workGraphPlan({ goal: '给张总再起草一封邮件，内容是提醒确认预算' }),
      ),
    });

    session.initialize();
    await session.submit('给张总写一封邮件，内容是汇报本周进展，用正式语气', { awaitAsyncWork: true });
    await session.submit('再给张总写一封邮件，内容是同步项目风险，用正式语气', { awaitAsyncWork: true });
    await session.submit('继续给张总准备一封邮件，内容是安排下周会议，用正式语气', { awaitAsyncWork: true });

    expect(session.getSnapshot().output.join('\n')).not.toContain('检测到重复模式');

    const manual = memoryEngine.addManual({
      content: '用正式语气',
      scope: 'contact',
      type: 'contact',
      subject: '张总',
    });
    await session.submit('给张总再起草一封邮件，内容是提醒确认预算');
    await session.waitForAsyncWork();

    const output = session.getSnapshot().output.join('\n');
    expect(output).not.toContain('记忆召回确认');
    expect(output).not.toContain('已自动采用记忆');
    const finalExecution = (executor.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(finalExecution.context.selectedEvidence).toEqual([
      expect.objectContaining({ ref: { kind: 'current_user_input' } }),
    ]);
    expect(JSON.stringify(finalExecution.context)).not.toContain(manual.content);
  });

  it('applies explicit input, then project/contact, then global memory in a project task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const globalPreference = memoryEngine.addManual({
      content: '输出尽量简洁',
      scope: 'global',
      type: 'style',
    });
    const projectPreference = memoryEngine.addManual({
      content: 'Phoenix 项目材料统一使用 Phoenix 术语',
      scope: 'project',
      type: 'domain',
      subject: 'Phoenix',
    });
    const contactPreference = memoryEngine.addManual({
      content: '给张总的邮件使用正式语气',
      scope: 'contact',
      type: 'contact',
      subject: '张总',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: '项目周报已整理',
        exitCode: 0,
        durationMs: 100,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
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
      sessionId: 'sess_memory_round1_precedence',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({
          goal: '给张总整理一份 Phoenix 项目周报，今天明确要求先保留表格格式',
          contextRefs: [
            { kind: 'current_user_input' },
            { kind: 'preference', preferenceId: projectPreference.id },
          ],
        }),
      ),
    });

    session.initialize();
    await session.submit('给张总整理一份 Phoenix 项目周报，今天明确要求先保留表格格式');
    await session.waitForAsyncWork();

    const output = session.getSnapshot().output.join('\n');
    expect(output).not.toContain('记忆召回确认');
    // 偏好取舍由 Planner 通过 contextRefs 决定，代码侧不再输出自动采用/跳过统计。
    expect(output).not.toContain('已自动采用记忆');
    expect(output).not.toContain('已跳过不确定记忆');
    expect(output).not.toContain('输出尽量简洁');

    const executionInput = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const selectedPreferences = executionInput.context.selectedEvidence
      .filter((item: { ref: { kind: string } }) => item.ref.kind === 'preference');
    expect(selectedPreferences).toEqual([
      expect.objectContaining({
        ref: { kind: 'preference', preferenceId: projectPreference.id },
        content: projectPreference.content,
      }),
    ]);
    expect(JSON.stringify(executionInput.context)).not.toContain(globalPreference.content);
    expect(JSON.stringify(executionInput.context)).not.toContain(contactPreference.content);

    const finalOutput = session.getSnapshot().output.join('\n');
    expect(finalOutput).toContain('今天明确要求先保留表格格式');
    expect(finalOutput).not.toContain('[project] Phoenix 项目材料统一使用 Phoenix 术语');
    expect(finalOutput).not.toContain('[contact] 给张总的邮件使用正式语气');
    expect(finalOutput).not.toContain('[global] 输出尽量简洁');
  });

  it('自然语言重复请求既不阻塞确认，也不再生成候选提示', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: '邮件草稿已生成',
        exitCode: 0,
        durationMs: 120,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
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
      sessionId: 'sess_memory_round1_inline_confirm',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '给张总写一封邮件，内容是汇报本周进展，用正式语气' }),
        workGraphPlan({ goal: '再给张总写一封邮件，内容是同步项目风险，用正式语气' }),
        workGraphPlan({ goal: '继续给张总准备一封邮件，内容是安排下周会议，用正式语气' }),
      ),
    });

    session.initialize();
    await session.submit('给张总写一封邮件，内容是汇报本周进展，用正式语气', { awaitAsyncWork: true });
    await session.submit('再给张总写一封邮件，内容是同步项目风险，用正式语气', { awaitAsyncWork: true });
    await session.submit('继续给张总准备一封邮件，内容是安排下周会议，用正式语气', { awaitAsyncWork: true });

    const output = session.getSnapshot().output.join('\n');
    expect(output).not.toContain('[y] 确认');
    expect(output).not.toContain('[n] 忽略');
    expect(output).not.toContain('[e <新内容>] 编辑后确认');
    expect(output).not.toContain('已保留为候选，不等待确认');
    expect(memoryEngine.list({ status: 'confirmed' })).toHaveLength(0);
    expect(output).not.toContain('已确认偏好');
  });

  it('does not treat inline edit syntax as preference confirmation when no confirmation is pending', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: '邮件草稿已生成',
        exitCode: 0,
        durationMs: 120,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
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
      sessionId: 'sess_memory_round1_inline_edit',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '给张总写一封邮件，内容是汇报本周进展，用正式语气' }),
        workGraphPlan({ goal: '再给张总写一封邮件，内容是同步项目风险，用正式语气' }),
        workGraphPlan({ goal: '继续给张总准备一封邮件，内容是安排下周会议，用正式语气' }),
        workGraphPlan({ goal: 'e 给张总的邮件使用非常正式语气' }),
      ),
    });

    session.initialize();
    await session.submit('给张总写一封邮件，内容是汇报本周进展，用正式语气', { awaitAsyncWork: true });
    await session.submit('再给张总写一封邮件，内容是同步项目风险，用正式语气', { awaitAsyncWork: true });
    await session.submit('继续给张总准备一封邮件，内容是安排下周会议，用正式语气', { awaitAsyncWork: true });
    await session.submit('e 给张总的邮件使用非常正式语气', { awaitAsyncWork: true });

    const prefs = memoryEngine.list({ status: 'confirmed' });
    expect(prefs).toHaveLength(0);
    expect(session.getSnapshot().output.join('\n')).not.toContain('已编辑并确认偏好');
  });

  it('does not auto-capture a natural-language preference before planning', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: '已记录偏好候选',
        exitCode: 0,
        durationMs: 120,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
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
      sessionId: 'sess_memory_high_confidence_user_statement',
      contextRecaller,
      planningAgent: stubPlanningAgent(),
    });

    session.initialize();
    await session.submit('以后凡是长篇调研、人物研究、竞品分析，默认输出 Markdown 文件，并在聊天中只给摘要和文件路径', { awaitAsyncWork: true });

    expect(memoryEngine.list({ status: 'confirmed' })).toHaveLength(0);
    expect(session.getSnapshot().output.join('\n')).not.toContain('已自动记录偏好');
  });

  it('不再从 Executor 输出里抽取长期偏好候选', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: [
          '基于当前注入的近期上下文，我能提炼出几条“可沿用的工作记忆”：',
          '你明确偏好：**长篇调研型输出应该保存成本地 Markdown 文件**，不要只放在聊天里。',
          '凡是长篇调研、人物研究、竞品分析、资料汇总，默认输出 Markdown 文件，并在聊天中只给摘要和文件路径。',
        ].join('\n'),
        exitCode: 0,
        durationMs: 120,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
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
      sessionId: 'sess_memory_high_confidence_executor_statement',
      contextRecaller,
      executorFactory: () => executor,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '刚才基于上下文你能提炼出什么工作记忆？' }),
      ),
    });

    session.initialize();
    await session.submit('刚才基于上下文你能提炼出什么工作记忆？', { awaitAsyncWork: true });

    expect(session.getSnapshot().output.join('\n')).not.toContain('检测到可能的长期偏好');
    expect(memoryEngine.list({ status: 'confirmed' })).toHaveLength(0);
  });

  it('requires an explicit memory command for low-risk long-term preferences', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: 'noop',
        exitCode: 0,
        durationMs: 10,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
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
      sessionId: 'sess_memory_auto_capture_low_risk',
      contextRecaller,
      planningAgent: stubPlanningAgent(),
    });

    session.initialize();
    await session.submit('以后凡是复杂方案，默认先给结论，再列执行细节');

    const confirmed = memoryEngine.list({ status: 'confirmed' });
    expect(confirmed).toHaveLength(0);
    const output = session.getSnapshot().output.join('\n');
    expect(output).not.toContain('已自动记录偏好');
    expect(output).not.toContain('要把它记为长期偏好吗');

    await session.submit('/memory add 凡是复杂方案，默认先给结论，再列执行细节');
    expect(memoryEngine.list({ status: 'confirmed' })).toHaveLength(1);
  });

  it('does not create a high-risk memory candidate from natural language', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: 'noop',
        exitCode: 0,
        durationMs: 10,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
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
      sessionId: 'sess_memory_auto_capture_high_risk',
      contextRecaller,
      planningAgent: stubPlanningAgent(),
    });

    session.initialize();
    await session.submit('以后凡是报告都要自动发给客户');

    expect(memoryEngine.list({ status: 'confirmed' })).toHaveLength(0);
    const output = session.getSnapshot().output.join('\n');
    expect(output).not.toContain('高风险偏好不会静默写入');
  });
});
