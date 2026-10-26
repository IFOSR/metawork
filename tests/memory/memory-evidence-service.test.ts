import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { MemoryEvidenceService } from '../../src/memory/memory-evidence-service.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { MemoryBindingsRepo } from '../../src/storage/memory-bindings-repo.js';
import { MemoryFlushCursorRepo } from '../../src/storage/memory-flush-cursor-repo.js';
import { SqliteMemoryTurnSource } from '../../src/storage/memory-turn-source.js';
import { TaskExecutionEvidenceRepo } from '../../src/execution/execution-evidence-port.js';
import type { MemoryPort } from '../../src/memory/memory-port.js';
import type { ContextRef } from '../../src/work-graph/types.js';

const ACCOUNT = 'local-default';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO tasks
    (id, title, goal, status, created_at, updated_at, account_id, conversation_id, workspace_id)
    VALUES ('task-1', '记忆任务', '验证证据投递', 'running', '2026-10-22T00:00:00.000Z',
      '2026-10-22T00:00:00.000Z', 'local-default', 'conv-1', 'ws-1')`).run();
  return db;
}

class StubPort implements MemoryPort {
  body = '用户偏好中文表格输出。';
  fail = false;
  fetchCount = 0;

  async health() { return { ready: true, ftsAvailable: true }; }
  async deposit() { return { accepted: 0 }; }
  async search() { return { items: [], degraded: false }; }
  async materialize() {
    this.fetchCount += 1;
    if (this.fail) throw new Error('memory_engine_unavailable');
    return {
      id: 'tdai-1', type: 'instruction', content: this.body, background: null,
      createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
    };
  }
  async listAssets() { return { items: [], total: 0 }; }
  async updateAsset() { return { memoryId: 'tdai-1', version: 'v2' }; }
  async deleteAsset() { return { deleted: true }; }
  async readPersona() { return { content: null, updatedAt: null }; }
}

function buildService(db: Database.Database, port: MemoryPort) {
  const bindings = new MemoryBindingsRepo(db);
  const service = new MemoryService({
    port,
    bindings,
    cursors: new MemoryFlushCursorRepo(db),
    turns: new SqliteMemoryTurnSource(db),
  });
  const evidence = new MemoryEvidenceService({
    resolveService: () => service,
    evidenceRepo: new TaskExecutionEvidenceRepo(db),
    maxStoredChars: 8_192,
  });
  return { bindings, service, evidence };
}

describe('MemoryEvidenceService', () => {
  let db: Database.Database;
  let port: StubPort;

  beforeEach(() => {
    db = createTestDb();
    port = new StubPort();
  });

  it('collects the memory references of a work graph once', () => {
    const refs: ContextRef[] = [
      { kind: 'memory', memoryId: 'mem-1' },
      { kind: 'current_user_input' },
      { kind: 'memory', memoryId: 'mem-1' },
      { kind: 'memory', memoryId: 'mem-2' },
    ];
    expect(MemoryEvidenceService.collectMemoryRefs(refs)).toEqual(['mem-1', 'mem-2']);
  });

  it('materializes a referenced memory into the task evidence catalog', async () => {
    const { bindings, evidence } = buildService(db, port);
    const binding = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT });
    const result = await evidence.materialize({
      accountId: ACCOUNT,
      taskId: 'task-1',
      memoryIds: [binding.memoryId],
    });
    expect(result.failed).toEqual([]);
    expect(result.materialized).toHaveLength(1);
    const row = db.prepare('SELECT kind, source_id, content FROM task_execution_evidence WHERE task_id = ?')
      .get('task-1') as { kind: string; source_id: string; content: string };
    expect(row.kind).toBe('long_term_memory');
    expect(row.source_id).toBe(binding.memoryId);
    expect(row.content).toBe('用户偏好中文表格输出。');
  });

  it('refuses a memory that belongs to another account', async () => {
    const { bindings, evidence } = buildService(db, port);
    const binding = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'account-b' });
    const result = await evidence.materialize({
      accountId: ACCOUNT,
      taskId: 'task-1',
      memoryIds: [binding.memoryId],
    });
    expect(result.materialized).toEqual([]);
    expect(result.failed[0]?.reason).toMatch(/memory_not_authorized/u);
    expect(db.prepare('SELECT COUNT(*) AS total FROM task_execution_evidence').get())
      .toEqual({ total: 0 });
  });

  it('refuses a memory the user disabled after the plan was authorized', async () => {
    const { bindings, evidence } = buildService(db, port);
    const binding = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT });
    bindings.setEnabled(binding.memoryId, ACCOUNT, false);
    const result = await evidence.materialize({
      accountId: ACCOUNT,
      taskId: 'task-1',
      memoryIds: [binding.memoryId],
    });
    expect(result.failed).toHaveLength(1);
    expect(port.fetchCount).toBe(0);
  });

  it('never fakes an empty body when the engine fails', async () => {
    const { bindings, evidence } = buildService(db, port);
    const binding = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT });
    port.fail = true;
    const result = await evidence.materialize({
      accountId: ACCOUNT,
      taskId: 'task-1',
      memoryIds: [binding.memoryId],
    });
    expect(result.materialized).toEqual([]);
    expect(result.failed[0]?.reason).toContain('memory_engine_unavailable');
    expect(db.prepare('SELECT COUNT(*) AS total FROM task_execution_evidence').get())
      .toEqual({ total: 0 });
  });

  it('reuses an already materialized evidence row', async () => {
    const { bindings, evidence } = buildService(db, port);
    const binding = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT });
    await evidence.materialize({ accountId: ACCOUNT, taskId: 'task-1', memoryIds: [binding.memoryId] });
    await evidence.materialize({ accountId: ACCOUNT, taskId: 'task-1', memoryIds: [binding.memoryId] });
    expect(port.fetchCount).toBe(1);
  });

  it('truncates the body to the per-memory budget', async () => {
    const { bindings, service, evidence } = buildService(db, port);
    port.body = 'x'.repeat(9_000);
    const binding = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT });
    const bounded = new MemoryEvidenceService({
      resolveService: () => service,
      evidenceRepo: new TaskExecutionEvidenceRepo(db),
      maxStoredChars: 100,
    });
    await bounded.materialize({ accountId: ACCOUNT, taskId: 'task-1', memoryIds: [binding.memoryId] });
    const row = db.prepare('SELECT content FROM task_execution_evidence WHERE task_id = ?')
      .get('task-1') as { content: string };
    expect(row.content).toHaveLength(100);
    expect(evidence).toBeTruthy();
  });
});
