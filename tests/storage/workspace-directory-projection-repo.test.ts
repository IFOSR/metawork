import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteWorkspaceDirectoryProjectionRepo } from '../../src/storage/workspace-directory-projection-repo.js';
import type { WorkspaceConversationSummary } from '../../src/workspace/workspace-conversation-projector.js';

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  runMigrations(db);
  return { db, repo: new SqliteWorkspaceDirectoryProjectionRepo(db, 'local-default') };
}

function row(id: string, workspaceId = 'workspace_one'): WorkspaceConversationSummary {
  return {
    conversationId: id, workspaceId, title: `Title ${id}`, preview: '',
    createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
    latestTaskCreatedAt: '2026-09-26T00:00:00.000Z',
    archived: false,
    activity: {
      state: 'idle', taskId: null, updatedAt: '2026-09-26T00:00:00.000Z',
      latestTaskCreatedAt: '2026-09-26T00:00:00.000Z',
    },
  };
}

function begin(repo: SqliteWorkspaceDirectoryProjectionRepo, fingerprint: string): string {
  const token = repo.prepareRebuild();
  repo.beginRebuild(fingerprint, token);
  return token;
}

describe('Workspace directory durable projection', () => {
  it('keeps the checkpoint fixed-size and untouched by live metadata mutations', () => {
    const { db, repo } = fixture();
    for (let index = 0; index < 1200; index += 1) repo.upsert(row(`conv_${index}`));
    begin(repo, 'source');
    const checkpoint = () => (db.prepare(
      'SELECT checkpoint FROM workspace_directory_rebuilds WHERE account_id = ?',
    ).get('local-default') as { checkpoint: string }).checkpoint;
    const before = checkpoint();

    expect(before.length).toBeLessThan(512);
    for (let index = 0; index < 300; index += 1) repo.remove(`conv_${index}`);
    repo.upsert(row('conv_new'));
    repo.upsert({ ...row('conv_800'), title: 'Renamed' });
    repo.updateActivity('conv_801', { state: 'planning', taskId: null, updatedAt: 'now' });

    expect(checkpoint()).toBe(before);
  });

  it('uses only indexed point reads and writes on the live observation path', () => {
    const { db, repo } = fixture();
    const token = begin(repo, 'source');
    repo.writeBatch([row('conv_a')], 'conv_a', token);
    const operations: Array<{ sql: string; parameters: unknown[] }> = [];
    const prepare = db.prepare;
    const original = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = original(sql);
      return new Proxy(statement, {
        get(target, property) {
          if (property === 'get' || property === 'all' || property === 'run') {
            return (...parameters: unknown[]) => {
              operations.push({ sql, parameters });
              return target[property](...parameters);
            };
          }
          return Reflect.get(target, property, target);
        },
      });
    }) as typeof db.prepare;
    try {
      repo.upsert(row('conv_new'));
      repo.upsert({ ...row('conv_a'), title: 'New title' });
      repo.remove('conv_new');
      repo.updateActivity('conv_a', { state: 'planning', taskId: null, updatedAt: 'now' });
    } finally {
      db.prepare = prepare;
    }

    expect(operations.some(({ sql }) => /(?:INSERT INTO|UPDATE) workspace_directory_rebuilds/u.test(sql))).toBe(false);
    for (const { sql, parameters } of operations) {
      const plan = original(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[];
      expect(plan.some(item => /\bSCAN\b/u.test(item.detail)), sql).toBe(false);
    }
  });

  it('restarts an old cursor without candidate provenance without changing the schema', () => {
    const { db, repo } = fixture();
    const schema = () => db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    const before = schema();
    repo.upsert(row('conv_a'));
    repo.upsert(row('conv_missing'));
    db.prepare(`INSERT INTO workspace_directory_rebuilds VALUES ('local-default', 1, 'building', 'source', 'conv_a')`).run();

    const token = begin(repo, 'source');

    expect(repo.state()?.checkpoint).toBe('');
    repo.writeBatch([row('conv_a')], 'conv_a', token);
    repo.finishRebuild(token);
    expect(repo.find('conv_missing')).toBeNull();
    expect(repo.find('conv_a')).not.toBeNull();
    expect(schema()).toEqual(before);
  });

  it('requires a successful source read before accepting batches or reconciling candidates', () => {
    const { repo } = fixture();
    repo.upsert(row('conv_a'));
    const token = repo.prepareRebuild();

    expect(() => repo.writeBatch([row('conv_b')], 'conv_b', token)).toThrow('directory_source_not_read');
    expect(() => repo.finishRebuild(token)).toThrow('directory_source_not_read');
    expect(repo.find('conv_a')).not.toBeNull();
    expect(repo.find('conv_b')).toBeNull();
  });

  it('removes only unseen candidates and invalidates only affected Workspace cursors', () => {
    const { repo } = fixture();
    let token = begin(repo, 'source');
    repo.writeBatch([row('conv_a'), row('conv_b'), row('conv_c', 'workspace_two'), row('conv_d', 'workspace_two')], 'z', token);
    repo.finishRebuild(token);
    const removedCursor = repo.page('workspace_one', { limit: 1 }).nextCursor!;
    const unchangedCursor = repo.page('workspace_two', { limit: 1 }).nextCursor!;

    token = begin(repo, 'changed-source');
    repo.writeBatch([row('conv_a'), row('conv_c', 'workspace_two'), row('conv_d', 'workspace_two')], 'z', token);
    expect(repo.finishRebuild(token)).toBe(true);

    expect(repo.find('conv_b')).toBeNull();
    expect(() => repo.page('workspace_one', { cursor: removedCursor })).toThrow('stale_directory_cursor');
    expect(repo.page('workspace_two', { cursor: unchangedCursor }).items).toEqual([row('conv_d', 'workspace_two')]);
  });

  it('preserves concurrent creations, same-timestamp changes, and identical live upserts', () => {
    const { repo } = fixture();
    for (const id of ['conv_changed', 'conv_unchanged', 'conv_deleted']) repo.upsert(row(id));
    const token = begin(repo, 'stale-source');
    repo.upsert({ ...row('conv_changed'), title: 'Fresh' });
    repo.upsert(row('conv_unchanged'));
    repo.upsert(row('conv_new'));
    repo.writeBatch([row('conv_changed')], 'z', token);
    repo.finishRebuild(token);

    expect(repo.find('conv_changed')?.title).toBe('Fresh');
    expect(repo.find('conv_unchanged')).not.toBeNull();
    expect(repo.find('conv_new')).not.toBeNull();
    expect(repo.find('conv_deleted')).toBeNull();
  });

  it('makes removals idempotent and scoped to one account', () => {
    const { db, repo } = fixture();
    const other = new SqliteWorkspaceDirectoryProjectionRepo(db, 'other');
    other.upsert(row('conv_b'));
    const token = begin(repo, 'source');
    repo.writeBatch([row('conv_a'), row('conv_b'), row('conv_c')], 'z', token);
    repo.finishRebuild(token);
    repo.remove('conv_b');
    const cursor = repo.page('workspace_one', { limit: 1 }).nextCursor!;
    repo.remove('conv_b');

    expect(repo.find('conv_b')).toBeNull();
    expect(other.find('conv_b')).not.toBeNull();
    expect(repo.page('workspace_one', { cursor }).items).toEqual([row('conv_c')]);
  });

  it('keeps candidates and deletion fences after closing and reopening the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'metawork-directory-rebuild-'));
    directories.push(directory);
    const path = join(directory, 'projection.sqlite');
    const firstDb = new Database(path);
    databases.push(firstDb);
    runMigrations(firstDb);
    const first = new SqliteWorkspaceDirectoryProjectionRepo(firstDb, 'local-default');
    first.upsert(row('conv_missing'));
    let token = begin(first, 'source');
    first.writeBatch([row('conv_a')], 'conv_a', token);
    first.remove('conv_b');
    first.upsert(row('conv_new'));
    firstDb.close();
    const secondDb = new Database(path);
    databases.push(secondDb);
    const second = new SqliteWorkspaceDirectoryProjectionRepo(secondDb, 'local-default');
    token = begin(second, 'source');
    expect(second.state()?.checkpoint).toBe('conv_a');
    second.writeBatch([row('conv_b')], 'conv_b', token);
    second.finishRebuild(token);

    expect(second.find('conv_missing')).toBeNull();
    expect(second.find('conv_b')).toBeNull();
    expect(second.find('conv_new')).not.toBeNull();
    expect(second.find('conv_a')).not.toBeNull();
  });

  it('fences an obsolete rebuild before it can write, reconcile, or mark readiness', () => {
    const { repo } = fixture();
    const obsolete = begin(repo, 'source');
    const current = begin(repo, 'source');

    expect(() => repo.beginRebuild('obsolete', obsolete)).toThrow('stale_directory_rebuild');
    expect(() => repo.writeBatch([row('conv_old')], 'z', obsolete)).toThrow('stale_directory_rebuild');
    expect(() => repo.finishRebuild(obsolete)).toThrow('stale_directory_rebuild');
    repo.writeBatch([row('conv_current')], 'z', current);
    repo.finishRebuild(current);
    expect(repo.find('conv_old')).toBeNull();
  });

  it('rolls back a failed deletion batch and its cursor revisions before retrying', () => {
    const { db, repo } = fixture();
    let token = begin(repo, 'source');
    repo.writeBatch([row('conv_a'), row('conv_b')], 'z', token);
    repo.finishRebuild(token);
    const before = db.prepare('SELECT revision FROM workspace_directory_revisions').get();
    token = begin(repo, 'empty');
    db.exec(`CREATE TEMP TRIGGER fail_directory_delete BEFORE DELETE ON workspace_directory_projection
      WHEN OLD.conversation_id = 'conv_b' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);

    expect(() => repo.finishRebuild(token)).toThrow('injected failure');
    expect(repo.find('conv_a')).not.toBeNull();
    expect(repo.find('conv_b')).not.toBeNull();
    expect(repo.state()?.status).toBe('building');
    expect(db.prepare('SELECT revision FROM workspace_directory_revisions').get()).toEqual(before);
    db.exec('DROP TRIGGER fail_directory_delete');
    repo.finishRebuild(token);
    expect(repo.page('workspace_one', {}).items).toEqual([]);
  });

  it('commits imported rows and the resume cursor atomically', () => {
    const { db, repo } = fixture();
    const token = begin(repo, 'source');
    db.exec(`CREATE TEMP TRIGGER fail_directory_insert BEFORE INSERT ON workspace_directory_projection
      WHEN NEW.conversation_id = 'conv_b' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);

    expect(() => repo.writeBatch([row('conv_a'), row('conv_b')], 'conv_b', token)).toThrow('injected failure');
    expect(repo.find('conv_a')).toBeNull();
    expect(repo.state()?.checkpoint).toBe('');
    expect(db.prepare('SELECT * FROM workspace_directory_revisions').all()).toEqual([]);
    db.exec('DROP TRIGGER fail_directory_insert');
    repo.writeBatch([row('conv_a'), row('conv_b')], 'conv_b', token);
    repo.finishRebuild(token);
    expect(repo.page('workspace_one', {}).items).toHaveLength(2);
  });

  it('reconciles in bounded restartable batches and protects observations between cleanup batches', () => {
    const { db, repo } = fixture();
    for (let index = 0; index < 205; index += 1) repo.upsert(row(`conv_${String(index).padStart(3, '0')}`));
    const token = begin(repo, 'empty');
    expect(repo.finishRebuild(token)).toBe(false);
    expect(repo.state()?.status).toBe('building');
    expect(db.prepare('SELECT count(*) AS count FROM workspace_directory_projection').get()).toEqual({ count: 105 });
    repo.upsert(row('conv_204'));
    const reopened = new SqliteWorkspaceDirectoryProjectionRepo(db, 'local-default');
    const resumed = begin(reopened, 'empty');
    while (!reopened.finishRebuild(resumed)) { /* Drain bounded cleanup batches. */ }

    expect(reopened.page('workspace_one', {}).items).toEqual([row('conv_204')]);
  });

  it('reflects an authoritative empty-Conversation rebinding and invalidates both directories', () => {
    const { repo } = fixture();
    const token = begin(repo, 'source');
    repo.writeBatch([row('conv_a'), row('conv_b'), row('conv_c', 'workspace_two'), row('conv_d', 'workspace_two')], 'z', token);
    repo.finishRebuild(token);
    const firstCursor = repo.page('workspace_one', { limit: 1 }).nextCursor!;
    const secondCursor = repo.page('workspace_two', { limit: 1 }).nextCursor!;
    repo.upsert({ ...row('conv_a', 'workspace_two'), updatedAt: '2026-09-26T01:00:00.000Z' });
    expect(repo.find('conv_a')?.workspaceId).toBe('workspace_two');
    expect(repo.page('workspace_one', {}).items.map(item => item.conversationId)).toEqual(['conv_b']);
    expect(() => repo.page('workspace_one', { cursor: firstCursor })).toThrow('stale_directory_cursor');
    expect(() => repo.page('workspace_two', { cursor: secondCursor })).toThrow('stale_directory_cursor');
  });
  it('retains durable invalidation across restart and only acknowledges the observed revision', () => {
    const { db, repo } = fixture();
    db.prepare(`
      INSERT INTO tasks (id, title, account_id, conversation_id, created_at, updated_at)
      VALUES ('task_one', 'Task', 'local-default', 'conv_a', 'now', 'now')
    `).run();
    const dirty = repo.listDirty(10);
    expect(dirty).toEqual([{ conversationId: 'conv_a', revision: 1 }]);
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = 'task_one'").run();
    const reopened = new SqliteWorkspaceDirectoryProjectionRepo(db, 'local-default');
    reopened.acknowledgeDirty(dirty[0]!);
    expect(reopened.listDirty(10)).toEqual([{ conversationId: 'conv_a', revision: 2 }]);
    reopened.acknowledgeDirty(reopened.listDirty(10)[0]!);
    expect(reopened.listDirty(10)).toEqual([]);
  });
  it('fails closed until a checkpointed rebuild completes, including after reopening', () => {
    const { db, repo } = fixture();
    expect(() => repo.page('workspace_one', {})).toThrow('directory_rebuilding');
    const token = begin(repo, 'source-1');
    repo.writeBatch([row('conv_a')], 'conv_a', token);
    const reopened = new SqliteWorkspaceDirectoryProjectionRepo(db, 'local-default');
    expect(reopened.state()).toMatchObject({
      status: 'building', sourceFingerprint: 'source-1', checkpoint: 'conv_a',
    });
    expect(() => reopened.page('workspace_one', {})).toThrow('directory_rebuilding');
    reopened.finishRebuild(token);
    expect(reopened.page('workspace_one', {}).items.map(item => item.conversationId))
      .toEqual(['conv_a']);
  });

  it('pages with deterministic keysets, scopes cursors, and rejects stale pages explicitly', () => {
    const { repo } = fixture();
    const token = begin(repo, 'source');
    repo.writeBatch([row('conv_c'), row('conv_b'), row('conv_a'), row('conv_other', 'workspace_two')], 'z', token);
    repo.finishRebuild(token);
    const first = repo.page('workspace_one', { limit: 2 });
    expect(first.items.map(item => item.conversationId)).toEqual(['conv_a', 'conv_b']);
    expect(repo.page('workspace_one', { cursor: first.nextCursor!, limit: 2 }).items
      .map(item => item.conversationId)).toEqual(['conv_c']);
    expect(() => repo.page('workspace_two', { cursor: first.nextCursor! }))
      .toThrow('invalid_cursor');
    expect(() => repo.page('workspace_one', { cursor: first.nextCursor!, query: 'Title' }))
      .toThrow('invalid_cursor');
    repo.upsert({
      ...row('conv_d'),
      latestTaskCreatedAt: '2026-09-27T00:00:00.000Z',
      activity: {
        state: 'blocked', taskId: 'task_one', updatedAt: 'now',
        latestTaskCreatedAt: '2026-09-27T00:00:00.000Z',
      },
    });
    expect(() => repo.page('workspace_one', { cursor: first.nextCursor! }))
      .toThrow('stale_directory_cursor');
    expect(repo.page('workspace_one', {}).items[0]?.conversationId).toBe('conv_d');
  });

  it('does not invalidate a cursor for another Workspace or identical upserts', () => {
    const { repo } = fixture();
    const token = begin(repo, 'source');
    repo.writeBatch([row('conv_a'), row('conv_b')], 'z', token);
    repo.finishRebuild(token);
    const first = repo.page('workspace_one', { limit: 1 });
    repo.upsert(row('conv_a'));
    repo.upsert(row('conv_other', 'workspace_two'));
    expect(repo.page('workspace_one', { cursor: first.nextCursor! }).items)
      .toEqual([row('conv_b')]);
  });

  it('keeps metadata and activity independently monotonic during a rebuild', () => {
    const { repo } = fixture();
    const token = begin(repo, 'source');
    repo.upsert({ ...row('conv_a'), title: 'New title', updatedAt: '2026-09-26T02:00:00.000Z',
      activity: { state: 'executing', taskId: 'task_a', updatedAt: '2026-09-26T01:00:00.000Z' } });
    repo.writeBatch([row('conv_a')], 'conv_a', token);
    repo.finishRebuild(token);
    expect(repo.find('conv_a')).toMatchObject({ title: 'New title', activity: { state: 'executing' } });
    repo.updateActivity('conv_a', { state: 'idle', taskId: null, updatedAt: '2026-09-26T03:00:00.000Z' });
    expect(repo.find('conv_a')).toMatchObject({ title: 'New title', activity: { state: 'idle' } });
  });

  it('uses the directory index without sorting or scanning other workspaces', () => {
    const { db, repo } = fixture();
    const token = begin(repo, 'source');
    repo.writeBatch(Array.from({ length: 3114 }, (_, index) => (
      row(`conv_${index}`, index < 40 ? 'workspace_one' : 'workspace_unrelated')
    )), 'z', token);
    repo.finishRebuild(token);
    const queries: string[] = [];
    // EXPLAIN the actual paged SQL rather than a separate hand-written query.
    const original = db.prepare.bind(db);
    const prepare = db.prepare;
    db.prepare = ((sql: string) => {
      if (sql.includes('SELECT summary_json')) queries.push(sql);
      return original(sql);
    }) as typeof db.prepare;
    expect(repo.page('workspace_one', { limit: 10 }).items).toHaveLength(10);
    db.prepare = prepare;
    const explanation = original(`EXPLAIN QUERY PLAN ${queries[0]}`).all({
      accountId: 'local-default', workspaceId: 'workspace_one', archived: 0,
      limit: 11, query: '', latestTaskCreatedAt: '', id: '',
    }) as { detail: string }[];
    expect(explanation.some(item => item.detail.includes('workspace_directory_page'))).toBe(true);
    expect(explanation.some(item => item.detail.includes('TEMP B-TREE'))).toBe(false);
  });
});
