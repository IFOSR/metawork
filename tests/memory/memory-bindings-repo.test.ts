import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { MemoryBindingsRepo, memoryContentDigest } from '../../src/storage/memory-bindings-repo.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('MemoryBindingsRepo', () => {
  let db: Database.Database;
  let repo: MemoryBindingsRepo;

  beforeEach(() => {
    db = createTestDb();
    repo = new MemoryBindingsRepo(db);
  });

  it('stores only ownership, the switch and a digest — never the body', () => {
    const record = repo.upsert({
      tdaiMemoryId: 'tdai-1',
      accountId: 'local-default',
      content: '用户偏好中文表格',
    });
    const row = db.prepare('SELECT * FROM memory_bindings WHERE memory_id = ?')
      .get(record.memoryId) as Record<string, unknown>;
    expect(row.content_digest).toBe(memoryContentDigest('用户偏好中文表格'));
    expect(JSON.stringify(row)).not.toContain('用户偏好中文表格');
  });

  it('never returns an asset of another account', () => {
    repo.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'account-a' });
    expect(repo.findEnabledForAccount('mem_x', 'account-b')).toBeNull();
  });

  it('never returns a disabled asset', () => {
    const record = repo.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'local-default' });
    repo.setEnabled(record.memoryId, 'local-default', false);
    expect(repo.findEnabledForAccount(record.memoryId, 'local-default')).toBeNull();
    expect(repo.findByMemoryId(record.memoryId, 'local-default')?.enabled).toBe(false);
  });

  it('re-enables an asset for the owning account only', () => {
    const record = repo.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'local-default' });
    expect(repo.setEnabled(record.memoryId, 'account-b', false)).toBeNull();
    expect(repo.setEnabled(record.memoryId, 'local-default', false)?.enabled).toBe(false);
    expect(repo.setEnabled(record.memoryId, 'local-default', true)?.enabled).toBe(true);
  });

  it('resolves a binding by the engine id', () => {
    repo.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'local-default' });
    expect(repo.findByTdaiMemoryId('tdai-1', 'local-default')?.accountId).toBe('local-default');
    expect(repo.findByTdaiMemoryId('tdai-missing', 'local-default')).toBeNull();
  });

  it('lists only the account assets and honours the disabled filter', () => {
    repo.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'local-default' });
    const second = repo.upsert({ tdaiMemoryId: 'tdai-2', accountId: 'local-default' });
    repo.upsert({ tdaiMemoryId: 'tdai-3', accountId: 'account-b' });
    repo.setEnabled(second.memoryId, 'local-default', false);

    expect(repo.listByAccount({
      accountId: 'local-default', limit: 10, offset: 0, includeDisabled: false,
    }).total).toBe(1);
    expect(repo.listByAccount({
      accountId: 'local-default', limit: 10, offset: 0, includeDisabled: true,
    }).total).toBe(2);
  });

  it('deletes only the owning account assets', () => {
    const record = repo.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'local-default' });
    expect(repo.delete(record.memoryId, 'account-b')).toBe(false);
    expect(repo.delete(record.memoryId, 'local-default')).toBe(true);
    expect(repo.findByMemoryId(record.memoryId, 'local-default')).toBeNull();
  });

  it('reuses the local id when the same engine asset is bound again', () => {
    const first = repo.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'local-default' });
    const second = repo.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'local-default' });
    expect(second.memoryId).toBe(first.memoryId);
    expect(repo.listByAccount({
      accountId: 'local-default', limit: 10, offset: 0, includeDisabled: true,
    }).total).toBe(1);
  });

  it('keeps the disabled state when the asset is bound again', () => {
    const first = repo.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'local-default' });
    repo.setEnabled(first.memoryId, 'local-default', false);
    const second = repo.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'local-default' });
    expect(second.memoryId).toBe(first.memoryId);
    expect(second.enabled).toBe(false);
  });

  it('keeps the digest when an update carries no body', () => {
    const record = repo.upsert({
      tdaiMemoryId: 'tdai-1', accountId: 'local-default', content: '原始内容',
    });
    repo.upsert({
      memoryId: record.memoryId,
      tdaiMemoryId: 'tdai-1',
      accountId: 'local-default',
      confidence: 0.9,
    });
    expect(repo.findByMemoryId(record.memoryId, 'local-default')?.contentDigest).toBe(memoryContentDigest('原始内容'));
    expect(repo.findByMemoryId(record.memoryId, 'local-default')?.confidence).toBe(0.9);
  });

  it('projects a management summary without the body', () => {
    const record = repo.upsert({
      tdaiMemoryId: 'tdai-1',
      accountId: 'local-default',
      workspaceId: 'ws-1',
      content: '偏好',
    });
    const [summary] = repo.toSummaries([record]);
    expect(summary?.memoryId).toBe(record.memoryId);
    expect(summary?.workspaceId).toBe('ws-1');
    expect(JSON.stringify(summary)).not.toContain('偏好');
  });
});
