import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Dependency, Task } from '../../src/core/types.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';

let db: Database.Database;
let repo: TaskRepo;
let queries: string[];
const UNUSED_PAYLOAD = `UNUSED_TASK_BODY_${'x'.repeat(8192)}`;
const dependencies: Dependency[] = [{
  taskId: 'upstream', type: 'kernel_retry', description: 'Retry pending',
  status: 'waiting', createdAt: 'now',
}, {
  taskId: 'other', type: 'manual', description: 'Resolved dependency',
  status: 'resolved', createdAt: 'earlier',
}];

beforeEach(() => {
  queries = [];
  db = new Database(':memory:', { verbose: sql => queries.push(String(sql)) });
  runMigrations(db);
  repo = new TaskRepo(db);
  const insert = db.prepare(`INSERT INTO tasks
    (id, title, status, account_id, dependencies_json, snapshot_json, resources_json,
     artifacts_json, priority_json, injected_prefs_json, created_at, updated_at)
    VALUES (?, ?, 'blocked', ?, ?, ?, ?, ?, ?, ?, 'now', 'now')`);
  const body = JSON.stringify([UNUSED_PAYLOAD]);
  for (let n = 0; n < 10; n += 1) {
    insert.run(`task_${n}`, `Task ${n}`, 'local-default', JSON.stringify(dependencies),
      body, body, body, body, body);
  }
  insert.run('foreign_task', 'Foreign', 'other-account', '[]', body, body, body, body, body);
  queries.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

it('reads only typed timeline Task columns in one query for one or ten IDs', () => {
  for (const count of [1, 10]) {
    const ids = Array.from({ length: count }, (_, n) => `task_${n}`);
    const canonical = repo.findByIds('local-default', ids)
      .map(({ id, title, status, dependencies }) => ({ id, title, status, dependencies }));
    queries.length = 0;
    const parse = vi.spyOn(JSON, 'parse');
    const actual: Pick<Task, 'id' | 'title' | 'status' | 'dependencies'>[] =
      repo.findTimelineByIds('local-default', ids);
    expect(actual).toEqual(canonical);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/SELECT id, title, status, dependencies_json FROM tasks/i);
    expect(parse.mock.calls).toHaveLength(count);
    expect(parse.mock.calls.every(([raw]) => raw === JSON.stringify(dependencies))).toBe(true);
    parse.mockRestore();
  }
});

it('ignores unrelated malformed Task bodies while retaining account isolation and ID ordering', () => {
  db.exec(`UPDATE tasks SET snapshot_json = 'invalid-unused', resources_json = 'invalid-unused',
    artifacts_json = 'invalid-unused', priority_json = 'invalid-unused', injected_prefs_json = 'invalid-unused'`);
  expect(repo.findTimelineByIds('local-default', ['task_9', 'foreign_task', 'missing', 'task_0', 'task_9']))
    .toEqual(['task_0', 'task_9'].map(id => ({
      id, title: `Task ${id.slice(-1)}`, status: 'blocked', dependencies,
    })));
  expect(repo.findTimelineByIds('unknown-account', ['task_0', 'foreign_task'])).toEqual([]);
});

it('skips empty ID lists and rejects oversized lists before querying', () => {
  expect(repo.findTimelineByIds('local-default', [])).toEqual([]);
  expect(() => repo.findTimelineByIds('local-default', Array.from({ length: 101 }, (_, n) => `task_${n}`)))
    .toThrow('history_task_limit');
  expect(queries).toEqual([]);
  expect(repo.findTimelineByIds('local-default', Array.from({ length: 100 }, (_, n) => `task_${n}`)))
    .toHaveLength(10);
});
