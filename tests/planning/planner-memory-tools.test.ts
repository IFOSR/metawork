import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PlannerDataReader } from '../../src/planning/planner-mcp-server.js';
import { MemoryRecallRepo } from '../../src/storage/memory-recall-repo.js';
import { MemoryBindingsRepo } from '../../src/storage/memory-bindings-repo.js';

const ACCOUNT = 'local-default';
const CONVERSATION = 'conv-1';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}


/**
 * Mirror what the Server does: a recalled asset is bound locally (which is what
 * makes it referenceable and governable) and then projected into the recall
 * read model. The Planner only ever sees bound assets, which is what keeps a
 * disabled memory out of its results (review P2-3).
 */
function projectRecall(input: {
  db: Database.Database;
  conversationId?: string;
  candidates: Array<{ tdaiMemoryId: string; type: string; preview: string; score: number; enabled?: boolean }>;
}): string[] {
  const bindings = new MemoryBindingsRepo(input.db);
  const recall = new MemoryRecallRepo(input.db);
  const bound = input.candidates.map(candidate => {
    const record = bindings.upsert({
      tdaiMemoryId: candidate.tdaiMemoryId,
      accountId: ACCOUNT,
      content: candidate.preview,
    });
    if (candidate.enabled === false) bindings.setEnabled(record.memoryId, ACCOUNT, false);
    return { memoryId: record.memoryId, type: candidate.type, preview: candidate.preview, score: candidate.score };
  });
  recall.replace({
    accountId: ACCOUNT,
    conversationId: input.conversationId ?? CONVERSATION,
    candidates: bound,
  });
  return bound.map(item => item.memoryId);
}

function recordRuntimeMode(db: Database.Database, mode: string, detail: string | null = null) {
  db.prepare(`
    INSERT INTO memory_runtime_state (account_id, mode, detail, updated_at)
    VALUES (?, ?, ?, '2026-10-26T00:00:00.000Z')
    ON CONFLICT(account_id) DO UPDATE SET mode = excluded.mode, detail = excluded.detail
  `).run(ACCOUNT, mode, detail);
}

describe('Planner memory tools', () => {
  let db: Database.Database;
  let reader: PlannerDataReader;

  beforeEach(() => {
    db = createTestDb();
    recordRuntimeMode(db, 'enabled');
    reader = new PlannerDataReader(
      db,
      'session-1',
      () => ({ capabilities: [], agents: [] }) as never,
      CONVERSATION,
      () => [],
      ACCOUNT,
      [],
    );
  });

  it('returns the recalled candidates of the conversation', () => {
    const ids = projectRecall({
      db,
      candidates: [
        { tdaiMemoryId: 'tdai-1', type: 'instruction', preview: '用户要求以后都用中文表格输出', score: 0.9 },
        { tdaiMemoryId: 'tdai-2', type: 'persona', preview: '用户是做销售分析的', score: 0.4 },
      ],
    });
    const result = reader.searchMemory({});
    expect(result.count).toBe(2);
    expect(result.items[0]!.memoryId).toBe(ids[0]);
    expect(result.items[0]!.preview).toContain('中文表格');
    expect(result.degraded).toBe(false);
  });

  it('hides an asset the user disabled', () => {
    const ids = projectRecall({
      db,
      candidates: [
        { tdaiMemoryId: 'tdai-1', type: 'instruction', preview: '偏好中文表格', score: 0.9 },
        { tdaiMemoryId: 'tdai-2', type: 'persona', preview: '做销售分析', score: 0.4, enabled: false },
      ],
    });
    const result = reader.searchMemory({});
    expect(result.items.map(item => item.memoryId)).toEqual([ids[0]]);
  });

  it('reports degraded recall so the Planner can say memory is unavailable', () => {
    const recall = new MemoryRecallRepo(db);
    recall.recordDegraded({
      accountId: ACCOUNT, conversationId: CONVERSATION, degraded: true, reason: 'engine down',
    });
    recordRuntimeMode(db, 'degraded', 'engine down');
    const result = reader.searchMemory({});
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('engine down');
  });

  it('filters the candidates by the Planner query', () => {
    const ids = projectRecall({
      db,
      candidates: [
        { tdaiMemoryId: 'tdai-1', type: 'instruction', preview: '用户要求以后都用中文表格输出', score: 0.9 },
        { tdaiMemoryId: 'tdai-2', type: 'persona', preview: '用户是做销售分析的', score: 0.4 },
      ],
    });
    const result = reader.searchMemory({ query: '中文' });
    expect(result.count).toBe(1);
    expect(result.items[0]!.memoryId).toBe(ids[0]);
  });

  it('never returns candidates of another conversation', () => {
    projectRecall({
      db,
      conversationId: 'conv-other',
      candidates: [{ tdaiMemoryId: 'tdai-9', type: 'persona', preview: '别的会话', score: 1 }],
    });
    expect(reader.searchMemory({}).count).toBe(0);
  });

  it('never returns candidates of another account', () => {
    const otherBindings = new MemoryBindingsRepo(db);
    const other = otherBindings.upsert({ tdaiMemoryId: 'tdai-9', accountId: 'account-b' });
    new MemoryRecallRepo(db).replace({
      accountId: 'account-b',
      conversationId: CONVERSATION,
      candidates: [{ memoryId: other.memoryId, type: 'persona', preview: '别的账号', score: 1 }],
    });
    expect(reader.searchMemory({}).count).toBe(0);
  });

  it('returns only the bounded per-layer candidates and preview budgets', () => {
    const bindings = new MemoryBindingsRepo(db);
    const candidates = [...Array.from({ length: 6 }, (_, index) => ({ layer: 'l1' as const, id: `l1-${index}`, chars: 400 })),
      ...Array.from({ length: 4 }, (_, index) => ({ layer: 'l2' as const, id: `l2-${index}`, chars: 500 })),
      { layer: 'l3' as const, id: 'l3-0', chars: 1_500 }, { layer: 'l3' as const, id: 'l3-1', chars: 1_500 }];
    const recall = new MemoryRecallRepo(db);
    const items = candidates.map(candidate => {
      const binding = bindings.upsert({
        tdaiMemoryId: candidate.id, accountId: ACCOUNT, layer: candidate.layer,
        revision: `revision-${candidate.id}`, title: candidate.id,
      });
      return {
        memoryId: binding.memoryId, layer: candidate.layer, title: candidate.id,
        preview: 'x'.repeat(candidate.chars), revision: `revision-${candidate.id}`,
        score: 1, updatedAt: null, source: 'profile' as const,
      };
    });
    recall.replaceLayered({
      accountId: ACCOUNT, conversationId: CONVERSATION,
      recall: {
        l1: { status: 'available', durationMs: 11, candidateCount: 5, items: items.filter(item => item.layer === 'l1') },
        l2: { status: 'available', durationMs: 22, candidateCount: 3, items: items.filter(item => item.layer === 'l2') },
        l3: { status: 'available', durationMs: 33, candidateCount: 1, items: items.filter(item => item.layer === 'l3') },
      },
    });
    const result = reader.getMemoryContext({ limit: 10 }) as { layers: Record<string, {
      status: string;
      durationMs: number;
      candidateCount: number;
      items: Array<{ preview: string }>;
    }> };
    expect(result.layers.l1!.items).toHaveLength(5);
    expect(result.layers.l1).toMatchObject({ status: 'available', durationMs: 11, candidateCount: 5 });
    expect(result.layers.l1!.items[0]!.preview).toHaveLength(240);
    expect(result.layers.l2!.items).toHaveLength(3);
    expect(result.layers.l2).toMatchObject({ status: 'available', durationMs: 22, candidateCount: 3 });
    expect(result.layers.l2!.items[0]!.preview).toHaveLength(320);
    expect(result.layers.l3!.items).toHaveLength(1);
    expect(result.layers.l3).toMatchObject({ status: 'available', durationMs: 33, candidateCount: 1 });
    expect(result.layers.l3!.items[0]!.preview).toHaveLength(1_200);

    const filtered = reader.getMemoryContext({ limit: 10, query: 'l2-1' }) as {
      layers: Record<string, { items: Array<{ title: string }> }>;
    };
    expect(filtered.layers.l2!.items.map(item => item.title)).toEqual(['l2-1']);
    expect(filtered.layers.l1!.items).toEqual([]);
  });

  it('lists account asset inventory without making it a recall snapshot', () => {
    const bindings = new MemoryBindingsRepo(db);
    const first = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT });
    const second = bindings.upsert({
      tdaiMemoryId: 'tdai-2', accountId: ACCOUNT, layer: 'l2',
      title: 'weekly-report.md', revision: 'scene-revision',
    });
    bindings.setEnabled(second.memoryId, ACCOUNT, false);
    bindings.upsert({ tdaiMemoryId: 'tdai-3', accountId: 'account-b' });

    const assets = reader.listMemoryAssets();
    expect(assets.count).toBe(2);
    expect(assets.items.map(item => item.memoryId).sort())
      .toEqual([first.memoryId, second.memoryId].sort());
    expect(assets.items.find(item => item.memoryId === second.memoryId)?.enabled).toBe(false);
    expect(assets.items.find(item => item.memoryId === second.memoryId)).toMatchObject({
      type: 'scene', layer: 'l2', title: 'weekly-report.md', revision: 'scene-revision',
    });
    expect(reader.getMemoryContext().layers.l2?.items).toEqual([]);
  });

  it('returns an empty result when memory was never used', () => {
    expect(reader.searchMemory({}).count).toBe(0);
    expect(reader.listMemoryAssets().count).toBe(0);
  });

  it('marks the whole context degraded only when every layer is unavailable', () => {
    const recall = new MemoryRecallRepo(db);
    recall.replaceLayered({
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      recall: {
        l1: { status: 'degraded', reason: 'l1 down', durationMs: 20, candidateCount: 0, items: [] },
        l2: { status: 'degraded', reason: 'l2 down', durationMs: 21, candidateCount: 0, items: [] },
        l3: { status: 'degraded', reason: 'l3 down', durationMs: 22, candidateCount: 0, items: [] },
      },
    });
    const result = reader.getMemoryContext() as { degraded: boolean; advice?: string };
    expect(result.degraded).toBe(true);
    expect(result.advice).toContain('暂不可用');
  });
});
