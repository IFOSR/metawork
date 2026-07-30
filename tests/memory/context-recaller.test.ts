import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertInteraction(db: Database.Database, opts: {
  id: string;
  taskId: string;
  sessionId?: string;
  userInput: string;
  systemOutput: string;
  createdAt: string;
}) {
  db.prepare(
    'INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(opts.id, opts.taskId, opts.sessionId ?? null, opts.userInput, opts.systemOutput, 'claude-code', opts.createdAt);
}

describe('ContextRecaller', () => {
  let db: Database.Database;
  let recaller: ContextRecaller;

  beforeEach(() => {
    db = createTestDb();
    recaller = new ContextRecaller(db);
  });

  it('第一层：召回当前任务历史', () => {
    insertInteraction(db, {
      id: 'int_1', taskId: 'task_A', sessionId: 'sess_1',
      userInput: '分析搜索引擎', systemOutput: '已完成分析',
      createdAt: '2026-04-12T10:00:00Z',
    });
    insertInteraction(db, {
      id: 'int_2', taskId: 'task_A', sessionId: 'sess_1',
      userInput: '继续深入', systemOutput: '深入分析完成',
      createdAt: '2026-04-12T10:01:00Z',
    });

    const result = recaller.recall({
      taskId: 'task_A', sessionId: 'sess_1', userInput: '总结一下',
    });

    const taskTurns = result.filter(t => t.source === 'task');
    expect(taskTurns).toHaveLength(2);
    expect(taskTurns[0].userInput).toBe('分析搜索引擎');
  });

  it('第二层：召回同会话跨任务历史', () => {
    insertInteraction(db, {
      id: 'int_1', taskId: 'task_A', sessionId: 'sess_1',
      userInput: '搜索引擎调研', systemOutput: '调研结果...',
      createdAt: '2026-04-12T10:00:00Z',
    });
    insertInteraction(db, {
      id: 'int_2', taskId: 'task_B', sessionId: 'sess_1',
      userInput: '你刚才说的搜索引擎', systemOutput: '关于搜索引擎...',
      createdAt: '2026-04-12T10:05:00Z',
    });

    const result = recaller.recall({
      taskId: 'task_B', sessionId: 'sess_1', userInput: '继续',
    });

    const sessionTurns = result.filter(t => t.source === 'session');
    expect(sessionTurns).toHaveLength(1);
    expect(sessionTurns[0].taskId).toBe('task_A');
  });

  it('去重：同一条记录不会同时出现在任务层和会话层', () => {
    insertInteraction(db, {
      id: 'int_1', taskId: 'task_A', sessionId: 'sess_1',
      userInput: 'search engine 分析', systemOutput: '分析完成',
      createdAt: '2026-04-12T10:00:00Z',
    });

    const result = recaller.recall({
      taskId: 'task_A', sessionId: 'sess_1', userInput: 'search engine 总结',
    });

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('task');
  });

  it('output 截断至 150 字符', () => {
    const longOutput = '这是一段很长的输出'.repeat(50);
    insertInteraction(db, {
      id: 'int_1', taskId: 'task_A', sessionId: 'sess_1',
      userInput: '测试', systemOutput: longOutput,
      createdAt: '2026-04-12T10:00:00Z',
    });

    const result = recaller.recall({
      taskId: 'task_A', sessionId: 'sess_1', userInput: '继续',
    });

    expect(result[0].systemOutput.length).toBeLessThanOrEqual(153); // 150 + '...'
    expect(result[0].systemOutput).toMatch(/\.\.\.$/);
  });

  it('当前任务历史上限 10 轮', () => {
    for (let i = 0; i < 15; i++) {
      insertInteraction(db, {
        id: `int_${i}`, taskId: 'task_A', sessionId: 'sess_1',
        userInput: `问题 ${i}`, systemOutput: `回答 ${i}`,
        createdAt: `2026-04-12T10:${String(i).padStart(2, '0')}:00Z`,
      });
    }

    const result = recaller.recall({
      taskId: 'task_A', sessionId: 'sess_1', userInput: '继续',
    });

    const taskTurns = result.filter(t => t.source === 'task');
    expect(taskTurns).toHaveLength(10);
  });

  it('不再按关键词猜测跨会话历史（语义交给 Planner）', () => {
    insertInteraction(db, {
      id: 'int_old', taskId: 'task_X', sessionId: 'sess_old',
      userInput: 'search engine for agents 调研', systemOutput: '调研结果...',
      createdAt: '2026-04-11T10:00:00Z',
    });

    const result = recaller.recall({
      taskId: 'task_new', sessionId: 'sess_new', userInput: '上次讨论的 search engine',
    });

    expect(result).toHaveLength(0);
  });

  it('无历史时返回空数组', () => {
    const result = recaller.recall({
      taskId: 'task_none', sessionId: 'sess_none', userInput: '你好',
    });
    expect(result).toHaveLength(0);
  });

});
